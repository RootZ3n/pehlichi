# Peh on the Phone — Operating Notes

Phone Peh is the **real Pehlichi coordinator runtime** (this repo) running on the Pixel 9 as the
main daily-driver agent. Same code as the lab Peh (trio-identical); only *config* differs. This doc
is the "how do I run and fix it" reference.

## Access
- **Chat UI:** phone browser → **`http://localhost:18830/chat.html`** (Add to Home Screen for an app feel).
  Element-style chat: attach images/docs (＋), per-message token/cost, copy a message or the whole
  conversation (⧉), and a **model dropdown** in the header to switch on the fly.
- Server binds `127.0.0.1:18830` (on-device only). Reached over Tailscale only via ssh, not the browser.

## Restarting Peh  ⚠️ (the important gotcha)
Android **reaps ssh-spawned background processes**. Reliable restart:
1. Open the **Termux** app on the phone (an open session, or Termux:Boot after a reboot).
2. Run: `bash ~/.termux/boot/start-peh.sh`
   - This does: wake-lock + sshd + Syncthing + a **supervised loop** that respawns Peh if Android kills it.
- A phone **reboot** also arms it (Termux:Boot must be installed + opened once).
- To restart *just the server* (pick up new code/config) without killing the supervisor:
  `pkill -f "node --import tsx"` (NOT `pkill -f server.ts` — that also kills the supervisor loop).
- Health check: `curl -s localhost:18830/health`.

## Where config lives
All phone-side config is in **`~/pehlichi/.env`** (chmod 600, NOT in git — runtime config, not code):

| Var | Purpose |
|-----|---------|
| `PEHLICHI_PORT` / `PEHLICHI_HOST` | 18830 / 127.0.0.1 |
| `MIMO_API_KEY`, `DEEPSEEK_API_KEY` | cloud brain keys (the 4 switchable models) |
| `IKBI_API_URL` + `IKBI_API_TOKEN` | **lab** ikbi (primary) over Tailscale |
| `IKBI_API_URL_FALLBACK` | **on-device** ikbi (`127.0.0.1:18796`) — used when the lab is unreachable |
| `GITHUB_TOKEN` | fine-grained PAT for `git_push`/`git_clone` (Contents:read/write on the peh repos) |
| `LAB_SSH_HOST` (`zen@100.84.209.89`) + `LAB_SHELL_ROOT` (`/pehverse/repos`) | `lab_shell` read-only repo scanning |
| `LAB_BRIDGE_HOST` (`100.84.209.89`) | reach the **lab's** services (luak/toba/nusika/howa/kokuli) over Tailscale |
| `AGENT_ALLOW_WRITES=true` | enables write tools (phone camera capture, git add/commit/push, lab_shell) |
| `LAB_TRANSCRIPT_DIR`, `MEMORY_STORE_ROOT`, `LABMEM_ROOT`, `LAB_STORE_ROOT`, `AGENT_SYNC_DIR` | phone-local memory dirs under `~/peh-data/` (Syncthing targets) |

## Capabilities & what each needs
- **Chat + cloud brain** — Mimo/DeepSeek keys. Works on internet alone (no PC needed).
- **Switch models on the fly** — 4 cloud presets (Mimo v2.5 / v2.5 Pro, DeepSeek v4 Flash / Pro).
  Header dropdown in the UI, or `POST /model {"id":"deepseek-v4-flash"}`. Conversation is preserved.
- **Camera / sensors** — the `phone_*` tools (Termux:API). Needs `AGENT_ALLOW_WRITES=true`.
- **git commit + push** — `git_*` tools, workspace-confined; push needs `GITHUB_TOKEN`.
- **Scan lab repos** — `lab_shell` (read-only SSH; allowlisted read commands + pipes, no writes).
- **Build/fix via ikbi** — `ikbi_build`/`ikbi_fix`/`ikbi_status`; prefers the lab ikbi, **falls back to the
  on-device ikbi** automatically if the lab is unreachable (PC-down resilience).
- **Invoke lab agents** — `bridge.request` / `lab_status_digest` reach luak/toba/nusika/howa/kokuli over
  Tailscale (via `LAB_BRIDGE_HOST`). Unreachable ⇒ reported down, Peh keeps working.
- **Memory sync** — every turn lands in `~/peh-data/` and Syncthing mirrors it to the PC (`~/peh-data`
  on the lab box). Chat on ONE device at a time to avoid sync conflicts.

## Routing note
A message only gets **tools** if it reaches the kernel. The fast-path sends pure small-talk to a
tool-free lane. It's forced to the kernel when the message has a task word, web intent, names a tool,
or asks to inspect a repo/the lab. If Peh ever answers a tool question from memory, add a word like
"run", "scan", or the tool name. `AGENT_FORCE_KERNEL=true` forces every message through the kernel.

## Failure modes
- **Peh unresponsive** → restart via the Termux step above.
- **"cannot reach ikbi"** → the lab ikbi is down AND the on-device one isn't running; start it with
  `bash ~/ikbi-agent/run-ikbi.sh serve` (it's normally supervised).
- **Lab agent "down"** → the PC/service is off, or Tailscale is down. Expected when away from the lab.
- **git_push refused** → `GITHUB_TOKEN` missing/expired in `.env`.
- **No internet at all** → the cloud brain can't answer (no on-device model by design).

## Devices
- Phone: **zenpix**, Tailscale `100.117.132.48`, Termux user `u0_a352`, sshd port 8022, ssh alias `pixel`.
- Lab PC: **pehverse**, Tailscale `100.84.209.89`, user `zen`.
