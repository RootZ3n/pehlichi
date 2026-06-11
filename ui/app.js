// ══════════════════════════════════════════════════════════════════════
// PEHLICHI · APP GLUE — wires the live backend (api.js + scenes.js) into the
// inline world engine, and adds the chrome the engine doesn't own: a backend
// status dot, Peh's Journal, and a command bar. Loaded AFTER the inline engine
// so all of its globals exist. Peh is MALE (he/him).
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var esc = (typeof window.esc === 'function') ? window.esc : function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ── 1. Live workspace bodies — replace the "coming soon" placeholders ─────
  var _origBody = window.pehWorkspaceBody;
  window.pehWorkspaceBody = function (w, deckMarkup) {
    var def = (typeof pehWorkspaceDef === 'function') ? pehWorkspaceDef(w.defId) : null;
    if (def && def.kind === 'deck') return _origBody(w, deckMarkup); // overview = console override below
    if (window.PehScenes && PehScenes.has(w.defId)) {
      setTimeout(function () { PehScenes.fill(w.defId); }, 0);
      return PehScenes.liveContainer(w.defId);
    }
    return _origBody(w, deckMarkup);
  };

  // ── 2. Overview console — append a live settlement-status strip ───────────
  var _origConsole = window.renderObservatoryConsole;
  if (typeof _origConsole === 'function') {
    window.renderObservatoryConsole = function () {
      setTimeout(function () { if (window.PehScenes) PehScenes.fill('console'); }, 0);
      var extra = '<div class="obs-live"><h3 class="obs-section-title">Live settlement status</h3>' +
        (window.PehScenes ? PehScenes.liveContainer('console') : '') + '</div>';
      return _origConsole() + extra;
    };
  }

  // ── 3. Journal logging on navigation ──────────────────────────────────────
  function sceneTitle(id) {
    try { var s = pehScene(pehActiveProductId(), id); return s ? s.title : id; } catch (e) { return id; }
  }
  var _origActivate = window.pehHotspotActivate;
  window.pehHotspotActivate = function (sceneId, hotspotId) {
    try {
      var s = pehScene(pehActiveProductId(), sceneId);
      var h = s && s.hotspots ? s.hotspots.find(function (x) { return x.id === hotspotId; }) : null;
      if (h && h.greeting && window.PehGuide) PehGuide.log('Peh: “' + h.greeting + '”', 'peh');
    } catch (e) { /* ignore */ }
    return _origActivate(sceneId, hotspotId);
  };
  ['pehSetScene', 'pehGoScene'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (sceneId) {
      try { if (window.PehGuide) PehGuide.log('Traveled to ' + sceneTitle(sceneId) + '.', 'move'); } catch (e) {}
      return orig.apply(this, arguments);
    };
  });

  // ── 4. Backend status dot (top-right, outside #app so it survives renders) ─
  var statusEl = null, lastOnline = null;
  function buildStatus() {
    statusEl = document.createElement('button');
    statusEl.className = 'peh-status';
    statusEl.type = 'button';
    statusEl.title = 'Backend status — click to recheck';
    statusEl.innerHTML = '<i class="peh-status-dot"></i><span class="peh-status-txt">checking…</span>';
    statusEl.onclick = function () { pollHealth(true); };
    document.body.appendChild(statusEl);
  }
  async function pollHealth(manual) {
    if (!statusEl) return;
    var r = await window.PehAPI.health({ fresh: true });
    var dot = statusEl.querySelector('.peh-status-dot');
    var txt = statusEl.querySelector('.peh-status-txt');
    if (r.ok && r.data) {
      dot.className = 'peh-status-dot online';
      txt.textContent = 'online · ' + (r.data.toolCount != null ? r.data.toolCount + ' tools' : 'ok');
      statusEl.title = 'Pehlichi online — ' + (r.data.instanceId || '') + ' · commit ' + (r.data.commit || '?');
      if (lastOnline === false && window.PehGuide) PehGuide.log('The settlement is back online. *happy chittering*', 'ok');
      lastOnline = true;
    } else {
      dot.className = 'peh-status-dot offline';
      txt.textContent = 'offline';
      statusEl.title = 'Backend unreachable: ' + (r.error || 'no response');
      if (lastOnline !== false && window.PehGuide && lastOnline !== null) PehGuide.log('Lost the line to the settlement. *tail poofs*', 'warn');
      if (manual && window.PehGuide) PehGuide.log('Still no answer from :18830. Is the server running?', 'warn');
      lastOnline = false;
    }
  }

  // ── 5. Command bar (bottom, above the engine taskbar) ─────────────────────
  var COMMANDS = 'help, health, sessions, memories, agents, bridge, tools, goto <area>, ask <message>';
  function buildCommandBar() {
    var bar = document.createElement('form');
    bar.className = 'peh-cmd';
    bar.innerHTML =
      '<span class="peh-cmd-mark" aria-hidden="true">›</span>' +
      '<input class="peh-cmd-input" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="Ask Peh, or run a command — try: help">' +
      '<button class="peh-cmd-go" type="submit" aria-label="Run">Run</button>';
    document.body.appendChild(bar);
    var input = bar.querySelector('.peh-cmd-input');
    bar.onsubmit = function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      input.value = '';
      runCommand(v);
    };
  }

  var SCENE_ALIASES = {
    keep: 'the-keep', gate: 'main-gate', training: 'training-yard', armory: 'the-armory',
    quests: 'quest-board', market: 'market-square', campsite: 'the-campsite',
    chapel: 'the-chapel', study: 'the-study', memory: 'the-campsite', memories: 'the-campsite',
  };

  async function summarize(label, promise, fmt) {
    PehGuide.toggle(true);
    var r = await promise;
    if (!r.ok || !r.data) { PehGuide.log(label + ': offline (' + (r.error || '?') + ')', 'warn'); return; }
    PehGuide.log(label + ': ' + fmt(r.data), 'data');
  }

  async function runCommand(raw) {
    var parts = raw.split(/\s+/);
    var cmd = parts.shift().toLowerCase();
    var rest = parts.join(' ');
    if (!window.PehGuide) return;
    switch (cmd) {
      case 'help':
        PehGuide.toggle(true);
        PehGuide.log('Commands: ' + COMMANDS, 'note');
        break;
      case 'health':
        await summarize('Health', PehAPI.health({ fresh: true }), function (d) { return (d.status || '?') + ' · ' + (d.toolCount || 0) + ' tools · uptime ' + Math.round(d.uptime || 0) + 's'; });
        break;
      case 'sessions':
        await summarize('Sessions', PehAPI.sessions({ fresh: true }), function (d) { return d.count + ' active, ' + d.evicted + ' evicted'; });
        break;
      case 'memories':
        await summarize('Memories', PehAPI.memories({ fresh: true }), function (d) { return (d.pastLives || []).length + ' past lives, ' + (d.entries || []).length + ' curated'; });
        break;
      case 'agents':
        await summarize('Agents', PehAPI.agents({ fresh: true }), function (d) { return d.count + ' peers: ' + (d.agents || []).map(function (a) { return a.name; }).join(', '); });
        break;
      case 'bridge':
        await summarize('Bridges', PehAPI.bridge({ fresh: true }), function (d) { return d.connected + '/' + d.count + ' connected'; });
        break;
      case 'tools':
        await summarize('Tools', PehAPI.tools({ fresh: true }), function (d) { return d.count + ' tools available'; });
        break;
      case 'goto':
        var target = SCENE_ALIASES[rest.toLowerCase()] || rest;
        if (target && typeof pehGoScene === 'function' && pehScene(pehActiveProductId(), target)) {
          pehGoScene(target);
        } else {
          PehGuide.log('No such area: "' + rest + '". Try: keep, study, campsite, market…', 'warn');
        }
        break;
      case 'ask':
        if (!rest) { PehGuide.log('Ask me what? e.g. "ask how are you?"', 'note'); break; }
        await ask(rest);
        break;
      default:
        // Bare text → treat as a question for Peh.
        await ask(raw);
    }
  }

  async function ask(message) {
    PehGuide.toggle(true);
    PehGuide.log('You: ' + message, 'you');
    PehGuide.log('Peh is thinking… *scratches chin with tiny paw*', 'note');
    var r = await PehAPI.converse(message);
    if (r.ok && r.data && r.data.content) {
      PehGuide.log('Peh: ' + r.data.content, 'peh');
    } else if (r.status === 401) {
      PehGuide.log('Peh: The chat door is locked (needs a token). I can still show you data, though.', 'warn');
    } else {
      PehGuide.log('Peh: I would answer, but the line is dead. *gestures at paws* And I have THESE.', 'warn');
    }
  }

  window.PehApp = { runCommand: runCommand, ask: ask, pollHealth: pollHealth };

  // ── Boot ──────────────────────────────────────────────────────────────────
  function start() {
    if (window.PehGuide) PehGuide.init();
    buildStatus();
    buildCommandBar();
    if (window.PehGuide) PehGuide.log('Welcome to the Settlement. I\'m Peh — your guide. Tap a place, or type "help".', 'peh');
    // Re-render so the engine picks up the overridden workspace/console bodies.
    if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
    pollHealth();
    setInterval(function () { pollHealth(); }, 12000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
