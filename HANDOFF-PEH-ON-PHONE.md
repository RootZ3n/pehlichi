# HANDOFF — Full Peh (Pehlichi) as the phone daily-driver

**Goal (operator, 2026-07-21):** Run the *real* Peh — this `pehlichi` coordinator runtime,
not the in-ikbi Peh persona — on the Pixel 9 as an all-day chat companion. Chat with Peh on
the phone, use the phone camera/sensors, have every conversation persist and **sync back to the
lab** so work continues at home. Be able to **switch models/providers on the fly**.

Operator will likely switch to the phone mid-build; the work continues across devices until done.

## Decisions (locked with the operator)
- **Topology:** *both* runtimes installed on the phone, but **Peh is always-on** and **ikbi is
  dormant** — ikbi only wakes when a build/fix is actually requested.
- **ikbi wake:** Peh **auto-spawns** ikbi's server on demand (via her delegate/build path); it can
  idle down after. Operator never manually starts it.
- **Camera/sensors:** **PORT the `phone_*` tools into Peh** so camera/mic/sensors work anytime you
  chat with Peh — no need to wake ikbi.
- **Sync:** **Syncthing, bidirectional**, on Peh's memory dirs. No new code. Rule: chat on one
  device at a time (Syncthing conflict-copies otherwise — recoverable but messy).
- **Model switch:** **build it** — runtime driver/model hot-swap + a picker in Peh's TUI web UI.
  Currently unbuilt: `tui/src/server.ts:347` hardcodes `providerSwitch: false // …no runtime switch (P2)`.

## Where things live (verified 2026-07-21)
- **Peh runtime:** `ecosystem/pehlichi/src/core/` (own agent loop `loop.ts`, drivers mimo/llamacpp/
  ollama, `provider-chain.ts` + `circuit-breaker.ts` = automatic failover, 36 tool modules under
  `src/core/agent-tools/`, assembled by `createFullToolRegistry`). Persona = `src/profile.ts`
  (`pehProfile`, `coordinatorToolNames` allowlist).
- **Phone surface:** `ecosystem/pehlichi/tui/src/server.ts` — localhost HTTP server + web UI
  (adjacent ports ~18830/18831). This is the daily surface (mirrors ikbi's phone lesson: the web UI,
  not the SSH repl).
- **Memory (already file-based — this is the sync target):**
  - `src/core/lab-transcript.ts` — every turn appended to room JSONL. Dir = `LAB_TRANSCRIPT_DIR`
    else `lab-utilities/lab-store/.lab-transcripts`.
  - `memories/MEMORY.md` + `memories/USER.md` — curated.
  - External data stores via `.env`: `MEMORY_STORE_ROOT`, `LABMEM_ROOT`, `LAB_STORE_ROOT`, `AGENT_SYNC_DIR`.
- **Camera/sensor tools to port FROM:** `ecosystem/ikbi/src/modules/worker-model/builder-tools/phone-tools.ts`
  (+ `phone-tools.test.ts`). 8 tools: take_photo, record_audio, read_sensor, location, battery,
  speak, notify, torch — plus `phone_read_text` (OCR). Thin `termux-*` shells through governed-exec.
- **The Termux env gotcha (carry over from ikbi):** governed exec scrubs env to PATH/HOME/LANG;
  termux-api needs `ANDROID_*`/`BOOTCLASSPATH`/`TERMUX_*`/`PREFIX`/`LD_PRELOAD`. ikbi solved it via
  `IKBI_GOVERNED_EXEC_ENV_ALLOWLIST`. Replicate in Peh's exec path.
- **ikbi delegation:** Peh already holds `IKBI_API_TOKEN` in `.env` and delegates over HTTP.

## Phone deploy recipe (proven for ikbi last month — reuse)
- Pixel 9 on Tailscale; Termux + Termux:API from **F-Droid** (NOT Play Store — Play build silently
  fails camera). Termux:Boot installed + opened once to arm.
- Deploy = `pnpm build` → rsync `dist/` + `tui/` + `package.json` → phone `~/pehlichi/`,
  `npm install --omit=dev` on-device (pure-JS deps fine on aarch64 Node).
- Keep-alive = **Termux:Boot supervised loop** (`while true; serve; sleep 3`). SSH-spawned
  background procs get REAPED by Android — manage the server from an OPEN Termux/Boot context, not ssh.
- Locked on-device `.env` (chmod 600), keys piped from PC, never printed.

## Phases (sequenced: chatting ASAP; model-switch = the real dev, last)
1. **Peh live on phone** — build pehlichi green → deploy → Termux:Boot supervised serve → verify a
   real multi-turn chat lands in `.lab-transcripts/`. (deploy/config)
2. **Camera/sensors native to Peh** — port `phone-tools.ts` into `src/core/agent-tools/`, register in
   `createFullToolRegistry` + `coordinatorToolNames`, carry the Termux env-allowlist fix. Verify
   "take a photo and tell me what you see" with ikbi NOT running. (coding + tests)
3. **Lab sync** — Syncthing bidirectional on `.lab-transcripts/`, `memories/`, `AGENT_SYNC_DIR`. (config)
4. **On-the-fly model/provider switch** — copy ikbi's `setModel` hot-swap (message log untouched →
   context preserved). Add a set-active-driver path + endpoint + TUI picker offering driver+model
   pairs (Mimo cloud / local Ollama / llama.cpp). Flip `providerSwitch` true; update the
   `tui/src/write-safety.test.ts` capability assertion that pins it `false`. (coding + tests)
   - ikbi reference: `src/modules/chat/cli.ts` `/model` handler + `session.ts` `setModel()`.

## Guardrails
- Both repos: strict TS, `node:test`. `pnpm build` + `pnpm test` must be green before anything ships
  to the phone. Do NOT weaken existing tests to pass — fix code or add tests; only change a test when
  its pinned contract genuinely changed (e.g. the `providerSwitch` flip in Phase 4).
- Work on a branch (not `labmem-integration` directly unless operator says so).
- Camera vision through Mimo is ~2 min/photo (provider latency, not the phone) — Phase 4's switcher
  is the mitigation.

## Status log
- 2026-07-21: plan saved; baseline `pnpm build` + `pnpm test` green (307/307) on branch labmem-integration.
- 2026-07-21: **Phase 2 DONE (PC-side, uncommitted)** — ported phone tools into Peh:
  `src/core/agent-tools/phone-tools.ts` (9 tools, DI runner, Termux env-passthrough `buildPhoneEnv`
  + `PEHLICHI_PHONE_ENV_ALLOWLIST`, workspace-confined captures, local/ssh transport via
  `PEHLICHI_PHONE_SSH_HOST`) + `phone-tools.test.ts` (14 tests). Wired into `agent-tools/index.ts`
  registry + `profiles/agent.ts` allowlist (38→47). Updated the `agent.test.ts` canonical-union pin
  (38→47 — genuine contract change). **build clean, 321/321 tests pass.** NOT committed.
- 2026-07-21: **TRIO MIRROR (hard lab rule: trio identical except persona+skills).** Phase 2 mirrored
  to loony-luna + mad-ptah. Shared-core files (`phone-tools.ts`, `phone-tools.test.ts`, `agent-tools/
  index.ts`) copied VERBATIM (verified byte-identical across trio). Per-repo edits (persona/skills-bearing
  files): `profiles/agent.ts` allowlist +9, `profiles/agent.test.ts` union 38→47, `package.json` test list.
  Results: **pehlichi 321/321, luna 312/312 — both green.** ptah: my 14 phone tests pass; **4 PRE-EXISTING
  failures (work-orders/reports/onboarding/velum routes 404 in ptah's server)** confirmed present on a
  CLEAN checkout — unrelated to this work, flagged for separate fix.
  - RULE going forward: every Phase-4 (model-switch) change must land in all THREE repos. server.ts across
    the trio is identical EXCEPT branding (LUNA_/PTAH_/PEH ports+env+names) and skills (ptah has
    enableWorkOrders/enableOccasio). Structural code (driver ctor, capabilities, routes) is identical.
- 2026-07-21: **Phase 4 BACKEND DONE + mirrored across the trio (uncommitted).** On-the-fly model
  hot-swap — 4 CLOUD presets, NO local (operator's call): Mimo v2.5, Mimo v2.5 Pro, DeepSeek v4 Flash,
  DeepSeek v4 Pro. GLOBAL scope. Files:
  - `tui/src/lib/model-switch.ts` — `SwappableDriver` (wraps the shared driver; swap inner → hot-swap,
    history preserved), `availableModelTargets` (4 presets, env-overridable + `PEHLICHI_MODEL_TARGETS`),
    `resolveTargetRequest` (preset id OR custom {model,base_url?,key_kind?}), `buildDriverForTarget`
    (all cloud via MimoDriver — it routes Mimo api-key vs DeepSeek Bearer by URL). + `model-switch.test.ts`.
  - `tui/src/server.ts` — wrap driver in SwappableDriver; `resolveDeepseekKey()` (env or ~/bok "deepseek"
    line) + `keyForTarget`; `GET /models` + `POST /model` (auth-gated, mutating); model reporting →
    `currentModel()`; converse follows active target; `providerSwitch:false→true` + write-safety test flip.
  - **PROVEN via runtime smoke** (PC): GET /models lists 4, POST /model{id:deepseek-v4-pro} swaps active,
    `keyed:true` (DeepSeek key resolved from ~/bok), unauth POST → 401.
  - Mirrored to luna/ptah via `git apply -C1` of the server patch + verbatim lib copies. **pehlichi 327/327,
    luna 318/318 green; ptah +6 switch tests pass (4 pre-existing unrelated fails remain).**
- 2026-07-21: **Phase 1 DEPLOY DONE — Peh is LIVE on the Pixel 9 (zenpix, Tailscale).** Runs from source
  via `tsx` at `~/pehlichi`, server on `127.0.0.1:18830`. Deploy method: rsync source (no node_modules),
  `npm install` on-device (correct-arch tsx/esbuild), drop prebuilt `lab-memory`+`lab-store` dist into
  `node_modules` (avoids the `file:` path; NOTE: a later `npm install` PRUNES them — re-drop after any
  install). Locked `~/pehlichi/.env` (chmod 600): PEHLICHI_PORT=18830, MIMO_API_KEY + DEEPSEEK_API_KEY
  (piped from ~/bok), AGENT_ALLOW_WRITES=true, memory-dir paths under `~/peh-data/`, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1.
  Data/sync dirs: `~/peh-data/{transcripts,memories,labmem,lab-store,agent-sync,workspace}`.
  Persistence: `~/.termux/boot/start-peh.sh` (wake-lock + sshd + supervised serve loop) + `~/pehlichi/run-peh.sh`.
  **setsid+wake-lock survives ssh close** (proven). Arm via Termux:Boot (reboot) or run the boot script in an
  OPEN Termux session.
  - **Two deploy fixes (committed, trio-mirrored):** (1) `browser-manager.ts` lazy-loads Playwright (it threw
    "Unsupported platform: android" at module init → crashed the whole server); (2) server fast-path (converse
    lane) now RECORDS turns to the transcript so all-day CASUAL chat persists (was RAM-only). AGENT_FORCE_KERNEL
    env added. Undeclared dep `js-yaml` installed on-device (TODO: declare it in package.json for the trio).
  - **PROVEN on-device:** /health ok, /models lists 4, chat works (Mimo), casual chat persists (transcript
    grows), REAL phone_battery ("92%, discharging, GOOD, 30.2°C, 153 cycles"), model swap to deepseek keyed:true.
- 2026-07-21: **Phase 3 SYNCTHING DONE — bidirectional `~/peh-data` phone↔PC over Tailscale, PROVEN both ways.**
  Syncthing v2.1.2 both ends. Device IDs: PC(pehverse)=IJQW47T-UNGXCTL-R4LOO6F-T4VIBI7-DLNCXG2-6EG376U-3UG3GYT-3VVCOQQ,
  phone(zenpix)=5BVYYDY-IUDUCCB-Q2ZUUTX-KEBAO3W-SXERTHI-LE2QDAK-TKU3WLL-XJEZ6QR. Folder id `peh-data` (phone
  `~/peh-data` ↔ PC `/home/zen/peh-data`), each device addr = Tailscale IP:22000. PC keep-alive = systemd
  `--user` service `syncthing.service` (linger on); phone = in `~/.termux/boot/start-peh.sh`. PC binary =
  static in `~/.local/bin/syncthing` (no sudo). Configured via `syncthing cli --home <dir> config devices/folders`.
  NOTE: chat on ONE device at a time (concurrent JSONL appends → .sync-conflict copies). To make the PC's Peh
  SEE phone chats, point its LAB_TRANSCRIPT_DIR/memory envs at `/home/zen/peh-data/...` (not yet wired).
- NEXT: Phase 4 UI — a mobile, Element/Matrix-style CHAT UI for Peh (separate lightweight page, not the themed
  world-map SPA) with an inline model switcher → POST /model. ×3 repos, verify on served surface.
