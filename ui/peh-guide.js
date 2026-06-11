// ══════════════════════════════════════════════════════════════════════
// PEHLICHI · PEH GUIDE — Peh's Journal (a running log of activity) plus the
// in-character flavour lines that accompany navigation and commands. Peh is
// MALE (he/him). The journal is a slide-in drawer living OUTSIDE #app so it
// survives the engine's full-innerHTML re-renders.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var esc = (typeof window.esc === 'function') ? window.esc : function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  var journal = [];     // [{t, text, kind}] newest last
  var MAX = 50;
  var open = false;
  var drawer = null, badge = null, listEl = null;

  function timeStr(t) {
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
  }

  function log(text, kind) {
    journal.push({ t: Date.now(), text: String(text), kind: kind || 'note' });
    if (journal.length > MAX) journal.shift();
    renderList();
    flashBadge();
  }

  function renderList() {
    if (!listEl) return;
    if (!journal.length) {
      listEl.innerHTML = '<li class="peh-jrnl-empty">Quiet so far. Tap a place on the map and I\'ll note what we find. *settles tail*</li>';
      return;
    }
    var items = journal.slice().reverse().map(function (e) {
      return '<li class="peh-jrnl-item k-' + esc(e.kind) + '"><span class="peh-jrnl-time">' + esc(timeStr(e.t)) +
        '</span><span class="peh-jrnl-text">' + esc(e.text) + '</span></li>';
    });
    listEl.innerHTML = items.join('');
  }

  function flashBadge() {
    if (!badge) return;
    badge.textContent = String(journal.length);
    badge.classList.remove('pulse');
    // reflow to restart the animation
    void badge.offsetWidth;
    badge.classList.add('pulse');
  }

  function toggle(force) {
    open = (typeof force === 'boolean') ? force : !open;
    if (drawer) drawer.classList.toggle('open', open);
    if (open) renderList();
  }

  function init() {
    if (drawer) return;
    var btn = document.createElement('button');
    btn.className = 'peh-jrnl-btn';
    btn.type = 'button';
    btn.title = "Peh's Journal — recent activity";
    btn.setAttribute('aria-label', "Open Peh's Journal");
    btn.innerHTML = '<span class="peh-jrnl-ico" aria-hidden="true">📖</span><span class="peh-jrnl-label">Journal</span><span class="peh-jrnl-badge">0</span>';
    btn.onclick = function () { toggle(); };
    document.body.appendChild(btn);
    badge = btn.querySelector('.peh-jrnl-badge');

    drawer = document.createElement('aside');
    drawer.className = 'peh-jrnl-drawer';
    drawer.setAttribute('aria-label', "Peh's Journal");
    drawer.innerHTML =
      '<header class="peh-jrnl-head"><b>Peh\'s Journal</b><span>what we\'ve been up to</span>' +
      '<button class="peh-jrnl-close" type="button" aria-label="Close journal">×</button></header>' +
      '<ul class="peh-jrnl-list"></ul>';
    document.body.appendChild(drawer);
    listEl = drawer.querySelector('.peh-jrnl-list');
    drawer.querySelector('.peh-jrnl-close').onclick = function () { toggle(false); };
    renderList();
  }

  window.PehGuide = { init: init, log: log, toggle: toggle, entries: function () { return journal.slice(); } };
})();
