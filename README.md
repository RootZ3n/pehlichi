> **⚠️ LAB-ONLY PRODUCT — AUTHENTICATION IS YOUR RESPONSIBILITY**
>
> This tool is designed for **local/lab use only**. It binds to localhost by default
> and is meant to run behind Tailscale, a VPN, or on a private network.
>
> **If you expose any service to the public internet, YOU are responsible for
> securing it.** No authentication, rate-limiting, or access control will be added
> to this product. That is not a bug — it is a design decision.
>
> Expose at your own risk.

## 🐿️ Pehlichi — The Lab Coordinator

A brilliant scientist's consciousness, trapped in a squirrel's brain, with all his past life memories unlocked. Pehlichi = Choctaw for "guide."

### The Team

| Name | Choctaw Meaning | Past Life | Present Role |
|------|----------------|-----------|--------------|
| **Pehlichi** | Guide — *Peh* for short | Scientist, neuralink researcher | Leader, coordinator, the voice of the team |
| **Atoni** | — | — | Blue team sentinel — lab health watchdog, service monitoring |
| **Luak** | Fire | 1920s speedway racer | Model benchmarking, performance testing |
| **Howa** | To call out | Roman gladiator | Truthfulness evaluation, lie detection |
| **Kokuli** | To break or shatter | 1950s noir private eye | Code auditing, finding what's broken |
| **Ikbi** | To make, build | 1800s Choctaw medicine man | App building, turning descriptions into code |
| **Toba** | Made, created | Stone age toolmaker | Artifact generation, starter scaffolding |
| **Nusika** | Dream | Ancient library scholar | Knowledge storage, memory, recall |

---

## Quickstart

### Prerequisites

- Node.js >= 22
- pnpm (`npm i -g pnpm`)
- An AI model API key (MiMo, OpenRouter, or compatible)

### Install

```bash
git clone <repo-url> pehlichi
cd pehlichi
pnpm install

# Also install the TUI (web server) dependencies
cd tui && pnpm install && cd ..
```

### Configure

Copy the env template and fill in your API key:

```bash
cp .env.example .env   # or create .env with the vars below
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PEHLICHI_PORT` | `18830` | HTTP server port |
| `PEHLICHI_HOST` | `127.0.0.1` | Bind address |
| `PEHLICHI_WORKSPACE` | repo root | Workspace root for file ops |
| `AGENT_MODEL` | `mimo-v2.5` | LLM model name |
| `AGENT_BASE_URL` | `https://api.xiaomimimo.com/v1` | LLM API base URL |
| `AGENT_API_KEY` | *(none)* | API key for the LLM driver |
| `MIMO_API_KEY` | *(none)* | Fallback API key (legacy) |
| `IKBI_CHAT_TOKEN` | *(none)* | Bearer token for `/chat` auth (open if unset) |
| `LAB_STORE_ROOT` | `<workspace>/../lab-store` | Lab store directory |
| `AGENT_SYNC_DIR` | `<lab-store>/.agent-sync` | Shared agent coordination dir |
| `LAB_REGISTRY_PATH` | `/pehverse/repos/lab-utilities/lab-registry/services.json` | Canonical service registry |
| `TRIO_SESSION_TTL_MS` | `14400000` (4h) | Idle session eviction TTL |
| `PEHLICHI_COMMIT` | git SHA | Commit shown in `/health` |

### Build & Run

```bash
# Typecheck
pnpm build

# Run the server
node --import tsx tui/src/server.ts

# Run tests
pnpm test
```

The server starts at `http://127.0.0.1:18830`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health + instance info |
| GET | `/tools` | List available tools |
| GET | `/info` | Personality + identity |
| GET | `/agents` | Ecosystem agents (bridge registry) |
| GET | `/api/agents` | Alias for `/agents` |
| GET | `/api/bridge` | Bridge connection map |
| GET | `/api/sessions` | Active per-room sessions |
| GET | `/api/memories` | Past lives + lab-memory entries |
| GET | `/task/:id/status` | Poll bridge task status |
| POST | `/chat` | Full agent loop (tool-calling) |
| POST | `/chat/stream` | Streaming agent loop |
| POST | `/converse` | Lightweight personality chat (no tools) |
| POST | `/reset` | Reset session history |
| GET | `/receipts` | Recent receipts |
| GET | `/capabilities` | Capability summary |

---

## Capabilities

Pehlichi is the lab coordinator with **60+ tools** including:

- **File operations** — read, write, search, patch
- **Terminal** — run shell commands and manage background processes
- **Web** — search, extract, browse (Playwright)
- **Vision** — image analysis via `vision_analyze`
- **Memory** — persistent curated memory across conversations
- **Labmem** — lab-wide shared/own/project memory (recall + record)
- **Skills** — loadable skill modules (coordination, planning, safety, archivum, etc.)
- **Delegation** — spawn sub-agents for parallel work
- **Cron** — scheduled tasks that survive restarts
- **Bridge tools** — `bridge.health`, `bridge.list`, `bridge.request` for inter-agent HTTP calls
- **Lab-status digest** — `lab_status_digest` pings every ecosystem service, returns up/down
- **ikbi integration** — `ikbi_build`, `ikbi_fix`, `ikbi_status` for governed code generation
- **Coordination** — `todo`, `clarify`, `delegate_task`
- **Music** — MiniMax Music 2.6 for song generation
- **Brain** — gbrain knowledge bridge (search/think recall)

---

## Architecture

```
                 ┌─────────────────────┐
                 │     Web UI / TUI    │
                 └─────────┬───────────┘
                           │
                 ┌─────────▼───────────┐
                 │  Pehlichi HTTP      │  :18830
                 │  (KernelChatSession)│
                 └─────────┬───────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐      ┌─────▼─────┐     ┌─────▼─────┐
   │ Bridge  │      │ Tool      │     │ Kernel    │
   │ Registry│      │ Registry  │     │ Loop      │
   └────┬────┘      └───────────┘     └───────────┘
        │
   ┌────▼──────────────────────────────────────┐
   │  Ecosystem Services (localhost)           │
   │  ikbi :18796  toba :18815  nusika :18793 │
   │  howa :18799  kokuli :18800 luak :18795  │
   │  ittunaha :18821                          │
   └───────────────────────────────────────────┘
```

---

## License

Private — lab use only.
