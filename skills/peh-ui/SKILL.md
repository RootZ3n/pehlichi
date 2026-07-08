---
name: peh-ui
description: "Change the Pehverse UI (the Grove/Peh web app) safely — the edit→verify-served→SEE-it→deploy-to-phone recipe. UIs have no unit tests, so visual verification is the safety net."
triggers:
  - "ui"
  - "css"
  - "grove"
  - "button"
  - "the text"
  - "too small"
  - "too faint"
  - "brighter"
  - "bigger"
  - "layout"
  - "style"
  - "the screen"
  - "on my phone"
  - "move"
  - "hide"
  - "color"
  - "font"
---

# Peh ↔ the UI — changing the Grove/Peh web app

The full operator playbook lives in **`ikbi/docs/UI-OPERATIONS.md`** — read it first (`read_file`).
This skill is the short version + how *you* (with your tools) run the loop.

## Why UI is different from a code build

A code change goes through `ikbi_build` and the verification ladder (typecheck + tests). **The UI
has NO unit tests** — `ikbi_build` can't verify a CSS/layout change. So for pure UI/CSS/JS-in-`ui/`
changes you **do the edit directly and verify VISUALLY**. (If the change touches typed server code,
e.g. a new `/route`, use `ikbi_build` for that part.)

## The loop (every UI change)

1. **Locate.** The web app is `ikbi/ui/`: `ikbi.css` (all styling), `scenes.js` (Grove/chat),
   `app.js`, `index.html`. Served live from source at `:18796` — **no rebuild** for `ui/` edits.
   `search_files` / `read_file` to find the right selector or block.
2. **Edit.** `patch` (preferred) or `write_file`. Scope mobile fixes to `@media (max-width:640px)`
   — NOT `.peh-grove-only-mode` (that class only exists during the share-an-image flow: a classic trap).
3. **Verify it landed** (`terminal`): `curl -s http://127.0.0.1:18796/ikbi.css | grep -c '<your unique string>'`
   — `>=1` = the server serves it. `0` = wrong file/path.
4. **SEE it** (this is the real test — you have eyes):
   - `browser_navigate` to `http://127.0.0.1:18796`, then `browser_snapshot` / `browser_vision` to look.
     For the phone view, the change must show under a narrow viewport — also check with
     `terminal`: `node ikbi/scripts/ui-verify/ui-shot.mjs http://127.0.0.1:18796 /tmp/g.png --mobile`
     then `vision_analyze` the PNG. Confirm the change actually rendered (not just parsed).
   - Ask yourself the operator's question out loud: "is the star gone? is the text readable?"
5. **Deploy to the phone** (`terminal`): `rsync -az ikbi/ui/<file> pixel:ikbi-agent/ui/<file>` — the
   phone runs its OWN server; editing the PC copy is not enough. Verify on the phone too if reachable.
6. **Commit** (`terminal`): `git -C /pehverse/repos/ecosystem/ikbi add ui/<file> && git commit -m "fix(ui): <what+why>"`.
7. **Report honestly** — what changed, that you SAW it render, that it's deployed. If you couldn't
   verify visually, say so; never claim a UI change works when you only edited the file.

## Gotchas that cost real time (see UI-OPERATIONS.md §3)

- **"CSS won't update after reload" is almost never caching** — first check the rule is correctly
  scoped and that `curl | grep` shows it served. The service worker does NOT cache assets.
- **Readability = brightness + size.** The operator has low vision. Faint text (dim `--ikbi-stone`,
  low `opacity`, 11–13px) → full-contrast `--ikbi-cream`, `opacity:1`, larger (17px/16px on mobile).
  When told "bigger/brighter," push further.
- **Floating overlays that bury mobile chat** (hide under `@media(max-width:640px)`): `.peh-cmd`,
  `.peh-status`, `.peh-jrnl-btn`, `.ikbi-chat-btn`, `.peh-onboard-help`.
- **No `dist/ui`** — edit `ui/` and it's served.

## Deployment reach

The operator's primary surface is the **phone** (`localhost:18796` on the phone → rsync to `pixel`).
Other targets: PC `pehverse:18796` (edits the source directly), laptop `pehtop` (manual mirror). A
UI change that works on the PC but not the phone reads as "broken" — always sync the phone.

You are the coordinator: make the change small and focused, SEE it work, ship it to the phone, and
tell the operator plainly what they'll see when they reload.
