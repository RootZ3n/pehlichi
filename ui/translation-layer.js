// ══════════════════════════════════════════════════════════════════════
// PEHVERSE · TRANSLATION LAYER — when hovering a hotspot, Peh explains
// what it does in plain English. Labels stay fantasy; Peh translates.
//
// Usage: include AFTER the world engine, scenes.js, and the project's
// translations file:
//   <script src="translations-pehlichi.js"></script>
//   <script src="translation-layer.js"></script>
//   <link rel="stylesheet" href="translation-layer.css">
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var hints = window.__PEHVERSE_HINTS || {};
  var observer = null;

  // ── Peh's hint bubble ────────────────────────────────────────────────
  var bubble = null;
  function ensureBubble() {
    if (bubble) return;
    bubble = document.createElement('div');
    bubble.className = 'xlt-bubble';
    bubble.innerHTML =
      '<div class="xlt-bubble-icon">💬</div>' +
      '<div class="xlt-bubble-text"></div>';
    document.body.appendChild(bubble);
  }

  function showBubble(el, hint) {
    ensureBubble();
    bubble.querySelector('.xlt-bubble-text').textContent = hint;
    bubble.classList.add('visible');
    var r = el.getBoundingClientRect();
    // Position below the element, centered
    bubble.style.left = (r.left + r.width / 2) + 'px';
    bubble.style.top = (r.bottom + 10) + 'px';
    // Keep on screen
    requestAnimationFrame(function () {
      var br = bubble.getBoundingClientRect();
      if (br.right > window.innerWidth - 16) {
        bubble.style.left = (window.innerWidth - br.width - 16) + 'px';
      }
      if (br.left < 16) {
        bubble.style.left = '16px';
      }
      if (br.bottom > window.innerHeight - 16) {
        bubble.style.top = (r.top - br.height - 10) + 'px';
      }
    });
  }

  function hideBubble() {
    if (bubble) bubble.classList.remove('visible');
  }

  // ── Look up hint for an element's text ───────────────────────────────
  function findHint(text) {
    if (!text) return null;
    var trimmed = text.trim();
    if (hints[trimmed]) return hints[trimmed];
    var lower = trimmed.toLowerCase();
    for (var k in hints) {
      if (k.toLowerCase() === lower) return hints[k];
    }
    return null;
  }

  // ── Attach hover behavior to an element ──────────────────────────────
  function attachHint(el) {
    if (el.getAttribute('data-xlt')) return;
    var text = el.textContent.trim();
    var hint = findHint(text);
    if (!hint) return;
    el.setAttribute('data-xlt', 'hint');
    el.addEventListener('mouseenter', function () {
      var h = findHint(el.getAttribute('data-xlt-original') || el.textContent.trim());
      if (h) showBubble(el, h);
    });
    el.addEventListener('mouseleave', hideBubble);
  }

  // ── Scan for hintable elements ───────────────────────────────────────
  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    // Navigation buttons (scene tabs)
    scope.querySelectorAll('.settle-nav-btn, .peh-nav-btn, .nus-nav-btn, nav button').forEach(function (el) {
      if (findHint(el.textContent.trim())) attachHint(el);
    });
    // Hotspot buttons on the map
    scope.querySelectorAll('.settle-map button, .settle-hotspots button, [class*="hotspot"] button').forEach(function (el) {
      if (findHint(el.textContent.trim())) attachHint(el);
    });
    // Overview cards (the main gate area)
    scope.querySelectorAll('.settle-overview button, .settle-console button, .peh-panel-title').forEach(function (el) {
      if (findHint(el.textContent.trim())) attachHint(el);
    });
    // Stat labels
    scope.querySelectorAll('.peh-stat-l, .peh-stat span:last-child').forEach(function (el) {
      if (findHint(el.textContent.trim())) attachHint(el);
    });
    // Broad fallback: any button or heading that matches a known hint
    scope.querySelectorAll('button, h1, h2, h3, .peh-chip').forEach(function (el) {
      if (!el.getAttribute('data-xlt') && findHint(el.textContent.trim())) attachHint(el);
    });
  }

  // ── MutationObserver for dynamically rendered content ────────────────
  function startObserver() {
    if (observer) return;
    var app = document.getElementById('app');
    if (!app) return;
    var pending = false;
    observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        scan(document);
      });
    });
    observer.observe(app, { childList: true, subtree: true });
  }

  // ── Init ─────────────────────────────────────────────────────────────
  function init() {
    setTimeout(function () {
      scan(document);
      startObserver();
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.XLT = { scan: scan };
})();
