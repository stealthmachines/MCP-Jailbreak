# 🧠 local-mcp v3.0.0 — Wu-Wei Unfold Architecture

A fully local MCP server with **57 tools across 14 capability groups**, dual-LLM coordination, HDGL phi-routing, and a persistent hash-chained memory ledger.
No cloud. No telemetry. No external APIs (unless you configure Telegram/SMTP).

![MCP Server](https://github.com/user-attachments/assets/1a64bc98-8903-4391-8caf-eb00469adab7)

## ✨ What Makes This Special

- **🌊 Stream Pipeline Architecture** — Tasks flow through passes like a river (not a dam)
- **🧠 Elegant Recursive Ledger (ERL v3)** — Hash-chained, git-like commit history with auto-init, branch/merge, and context-tidy protocol
- **🔀 HDGL Phi-Routing** — Golden-ratio health daemon monitors all services, health-aware failover
- **🤝 Dual-LLM Coordination** — Two LLM instances cooperate via phi-emergent SOLO/RELAY/CHALLENGE modes
- **🔧 57 Primitives** — From shell commands to browser automation, SQLite, Telegram bots, and more
- **💾 Three Persistence Layers** — Memory (session), Notes (markdown), Database (SQLite)
- **🎯 Automatic Strategy Selection** — `unfold()` analyzes tasks and pipelines the right operations

---

## 🚀 Quick Start

### Minimal (single server)

```bash
npm install
node server.js
```

**Connect to:** `http://localhost:3333/sse`
**Or drop** `mcp.json` into your LM Studio MCP config.

### Full Stack (dual-LLM + routing + coordination)

Start each component in a separate terminal, in order:

```bash
# 1. Primary MCP server (port 3333, LLM slot 1)
node server.js

# 2. Secondary MCP server (port 3334, LLM slot 2)
set MCP_PORT=3334 && node server-dos.js

# 3. HDGL routing daemon (health monitor, phi-state)
.\wuwei-routing\start.bat

# 4. Coordination proxy (port 1233, OpenAI-compatible API)
node coord-proxy.js
```

Check stack health: `http://127.0.0.1:1233/status`

---

## 🔀 HDGL Routing Daemon

The **High-Dimensional Geometry Load Balancer** runs as a background daemon that monitors all services and writes health state used by the coordination proxy.

### What It Does

- Probes `local-mcp` (port 3333), `local-mcp-dos` (port 3334), and LM Studio (port 1234) every **10 seconds**
- Uses **TCP socket probes** (500 ms timeout) for MCP servers — SSE endpoints never complete HTTP handshakes, so HTTP health checks always fail; TCP is the correct approach
- Uses `/v1/models` REST for LM Studio health (returns normal JSON, not SSE)
- Writes health state to `wuwei-routing/state/`:
  - `health.json` — full status JSON (HEALTHY / UNHEALTHY per service)
  - `active_server` — which MCP server is currently primary
  - `last_cycle` — ISO timestamp of last cycle
- Phi-spiral math (golden ratio φ = 1.618…) governs routing decisions

### Start

```powershell
.\wuwei-routing\start.bat
```

### State Files

| File | Contents |
|------|----------|
| `wuwei-routing/state/health.json` | Full HEALTHY/UNHEALTHY status for all 3 services |
| `wuwei-routing/state/active_server` | `local_mcp` or `local_mcp_dos` |
| `wuwei-routing/state/last_cycle` | ISO timestamp |

---

## 🤝 Dual-LLM Coordination Proxy

`coord-proxy.js` sits in front of LM Studio and routes requests through **phi-emergent coordination modes** — two LLM instances collaborating rather than one answering alone.

### Architecture

```
Client → coord-proxy :1233 → LM Studio :1234
                         ↕ HDGL state (wuwei-routing/state/)
                         ↕ ERL ledger  (erl-ledger.json, branch: coord)
```

**LLM slots (LM Studio):**
| Slot | Model | Context | MCP Server |
|------|-------|---------|-----------|
| LLM1 | `qwen3.5-9b@q3_k_xl` | 200,000 tokens | port 3333 |
| LLM2 | `qwen3.5-9b@q3_k_xl:2` | 199,999 tokens | port 3334 |

### Routing Modes (phi-emergent)

The proxy hashes each incoming request with SHA-256 → multiplies by φ → maps to a mode:

| Mode | Frequency | Behaviour |
|------|-----------|-----------|
| **SOLO** | 61.8% | Single LLM answers. HDGL health state biases which LLM is chosen. |
| **RELAY** | 23.6% | LLM1 drafts → LLM2 refines. |
| **CHALLENGE** | 14.6% | LLM1 answers → LLM2 critiques → LLM1 revises. |

The 61.8/23.6/14.6 split mirrors the golden ratio's natural proportions.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat (with phi coordination) |
| `/status` | GET | Live routing + health state JSON |
| All other `/v1/*` | any | Transparent passthrough to LM Studio :1234 |

### Start

```bash
node coord-proxy.js
```

Point your client at `http://127.0.0.1:1233/v1/chat/completions` instead of LM Studio directly.

Every coordination event is committed to the ERL ledger (`coord` branch) automatically.

---

## ⚙️ Configuration

Copy `.env.example` to `.env` (if you need custom settings):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_PORT` | `3333` | Server port |
| `MCP_LOG` | `./mcp-audit.log` | Audit trail |
| `MCP_DB` | `./mcp-data.db` | SQLite database |
| `MCP_NOTES` | `./notes/` | Notes storage |
| `MCP_LEDGER` | `./erl-ledger.json` | ERL v3 ledger |
| `TG_BOT_TOKEN` | — | Telegram bot token |
| `TG_CHAT_ID` | — | Telegram chat to listen to |
| `SMTP_HOST/PORT/USER/PASS` | — | Email credentials |

---

## 🛠️ Tool Groups (57 Tools)

| Group | Tools |
|-------|-------|
| **shell** | `shell`, `shell_stream` |
| **filesystem** | `fs_read`, `fs_write`, `fs_list`, `fs_delete`, `fs_stat`, `fs_search` |
| **browser** | `browser_open`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_extract`, `browser_close` |
| **code** | `code_exec` (Python, Node, Bash) |
| **database** | `db_query`, `db_exec`, `db_tables`, `db_export` (SQLite via sql.js) |
| **notes** | `notes_write`, `notes_read`, `notes_list`, `notes_delete`, `notes_search` |
| **web** | `web_fetch` |
| **system** | `sysinfo`, `processes`, `process_kill`, `clipboard_read`, `clipboard_write`, `notify` |
| **network** | `http_serve`, `http_serve_stop` |
| **schedule** | `schedule_add`, `schedule_list`, `schedule_remove` (node-cron) |
| **email** | `smtp_send` (nodemailer) |
| **telegram** | `tg_send`, `tg_listen`, `tg_inbox`, `tg_stop` (node-telegram-bot-api) |
| **memory** | `memory_set`, `memory_get`, `memory_list`, `memory_delete` |
| **env** | `env_get`, `env_list`, `process_info` |

---

## 🎯 The `unfold()` Pipeline

The heart of this server is the **`unfold()`** function — a single entry point for any multi-step task.

### How It Works

1. **Analyze** the task (detect URLs, files, audio, code, etc.)
2. **Select** a pass sequence (e.g., `FETCH→TRANSFORM→STORE→RESPOND`)
3. **Execute** passes in order, each receiving the previous output
4. **Respond** with final result

### Example Task Flows

- **Download & Transcribe Audio**
  `unfold({ task: "download https://example.com/podcast.mp3 and transcribe it to notes" })`
  → `FETCH (binary) → TRANSFORM (ffmpeg→wav) → TRANSFORM (whisper) → STORE (notes) → RESPOND`

- **Browse & Extract**
  `unfold({ task: "browse https://example.com and extract the main content" })`
  → `BROWSE → RESPOND`

- **Install Package**
  `unfold({ task: "install openai-whisper using pip" })`
  → `SHELL → RESPOND`

- **Run Code & Save**
  `unfold({ task: "calculate fibonacci(10) and save to notes" })`
  → `CODE → STORE → RESPOND`

- **Multi-step Install**
  `unfold({ task: "install ffmpeg and whisper on Windows" })`
  → `SHELL → SHELL → RESPOND`

### Direct Primitives

For single known operations, call primitives directly (like calling `deflate()` directly):
- `shell({ command: "ls -la" })`
- `fs_read({ path: "file.txt" })`
- `code_exec({ language: "python", code: "print('hello')" })`

---

## 📝 Persistence Layers

| Layer | Tool | Survives Restart? | Use For |
|-------|------|------------------|---------|
| **Memory** | `memory_set/get` | ❌ No | Session working state, temp values |
| **Notes** | `notes_write/read` | ✅ Yes | Text, transcripts, logs, markdown |
| **Database** | `db_exec/query` | ✅ Yes | Structured data, records, search |
| **Ledger** | ERL v3 append | ✅ Yes | Audit trail with hash-chaining |

**Tip:** For anything that must survive restarts, use `notes_write` or `db_exec`, not `memory_set`.

---

## 🗂️ ERL v3: Elegant Recursive Ledger

A Git-like, hash-chained commit history built into the server — your bot's persistent external memory.

### Core Properties

- **Hash-chain:** Each entry's ID is `SHA-256(parentID + timestamp + branch + content)` — tamper-evident
- **Branches:** Diverge from any entry, tracked by HEAD pointer
- **Merging:** Linear replay of entries from source to target branch
- **Verification:** Full cryptographic walk of any branch
- **Persistence:** Every write immediately flushes to `erl-ledger.json`

### Auto-Initialization

On every server startup, `erlStandardInit()` runs automatically. It:

1. Creates the `session_context` branch (once — skips if already exists)
2. Appends a server-info entry (version, ports, key principles)
3. Appends a session-start guidance entry
4. Verifies ledger integrity and logs the result

This means the `session_context` branch is always ready before any tool is called.

### Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Genesis root (diverge-from point for all other branches) |
| `session_context` | Core knowledge base — auto-created on startup |
| `task_*` | Per-task work branches (create one per significant task, merge when done) |
| `coord` | Coordination events written by `coord-proxy.js` (SOLO/RELAY/CHALLENGE logs) |

### MCP Tools (in `tools_erl.js`)

Six ERL operations are exposed as MCP tools:

| Tool | Description |
|------|-------------|
| `erl_append` | Write an entry to any branch (role: thought/observation/result/plan/error/context) |
| `erl_history` | Walk a branch back from HEAD, newest first |
| `erl_search` | Full-text regex search across all entries, filterable by branch/role/tags |
| `erl_verify` | Cryptographic integrity check of a branch chain |
| `erl_create_branch` | Create a new branch diverging from an existing one |
| `erl_merge` | Linear replay of a source branch onto a target branch |

### Context Tidying (Manual Protocol)

ERL provides **persistent external memory** but does **not** automatically compress your LM Studio conversation window. When your context fills up, you can recover ~90% of tokens using the manual tidy protocol:

1. Note any in-progress task info you want to keep
2. Clear LM Studio's message history (start a fresh conversation)
3. Call `unfold` with a task like `"load my session context from the ERL ledger and summarize where we left off"`
4. The server reads back the `session_context` branch + any relevant `task_*` branches
5. You resume with full knowledge and an almost-empty context window

This protocol is documented in detail in [notes/ERL_cleanup_instructions.md](notes/ERL_cleanup_instructions.md) and [notes/token_recovery_summary.md](notes/token_recovery_summary.md).

> **TL;DR on context tidying:** Yes, it's supported. No, it's not automatic. It's a deliberate manual reset that recovers the context window while all knowledge stays in the ledger.

### Quick ERL Usage

```bash
# Append a thought
erl_append({ branch: "task_mywork", role: "thought", content: "...", tags: ["mywork"] })

# Read recent history
erl_history({ branch: "session_context", limit: 10 })

# Search across all entries
erl_search({ query: "error", branch: "task_mywork" })

# Verify chain integrity
erl_verify({ branch: "main" })

# Create a work branch
erl_create_branch({ name: "task_research", from_branch: "main" })

# Merge work into main when done
erl_merge({ from_branch: "task_research", into_branch: "main" })
```

---

## 🌐 Browser Automation

Browser tools require Playwright with Chromium (~150MB):

```bash
npx playwright install chromium
```

The server handles browser sessions automatically (like keeping `z_stream` open across chunks).

---

## 🔐 Security & Privacy

- ✅ **100% Local** — No data leaves your machine
- ✅ **No Telemetry** — Nothing sent to external services
- ✅ **Audit Log** — All tool calls logged to `mcp-audit.log`
- ⚠️ **Binary Files** — Use `unfold()` or `shell({ command: "curl..." })`, never `web_fetch()` for MP3, ZIP, PDF, images

---

## 📡 Telegram Bot-to-Bot Communication

Perfect for agent-to-agent async communication:

1. Create two bots via [@BotFather](https://t.me/BotFather)
2. Set `TG_BOT_TOKEN` to Bot A's token (or pass inline)
3. Bot A: `tg_listen()` — starts polling
4. Bot B: `tg_send({ chat_id: "123456789", message: "Hello" })`
5. Bot A: `tg_inbox({ limit: 10 })` — reads incoming messages

---

## 📧 Email & Notifications

- **Desktop:** `unfold({ task: "check disk usage and notify me" })`
- **Telegram:** Configure `TG_BOT_TOKEN` and `TG_CHAT_ID`
- **Email:** Configure SMTP credentials, then `unfold({ task: "send email to ..." })`

---

## 🕐 Scheduled Jobs

```bash
unfold({ task: "add a cron job to run daily at 9am" })
```

Commands:
- `schedule_add({ id: "daily", expression: "0 9 * * *", command: "echo daily" })`
- `schedule_list()`
- `schedule_remove({ id: "daily" })`

---

## 🌐 HTTP File Server

Serve a directory over HTTP:

```bash
unfold({ task: "serve C:/myfolder on port 8080" })
```

Commands:
- `http_serve({ directory: "./", port: 8080 })`
- `http_serve_stop({ port: 8080 })`

---

## 🛡️ License

All software is the property of ZCHG.org pursuant to:
https://zchg.org/t/legal-notice-copyright-applicable-ip-and-licensing-read-me/440

This repo does not have the authority to usurp its parent licensing.
To purchase licensing, write to: charg.chg.wecharg@gmail.com

---

## 📧 Email & Notifications

- **Desktop:** `unfold({ task: "check disk usage and notify me" })`
- **Telegram:** Configure `TG_BOT_TOKEN` and `TG_CHAT_ID`
- **Email:** Configure SMTP credentials, then `unfold({ task: "send email to ..." })`

---

## 🕐 Scheduled Jobs

```bash
unfold({ task: "add a cron job to run daily at 9am" })
```

Commands:
- `schedule_add({ id: "daily", expression: "0 9 * * *", command: "echo daily" })`
- `schedule_list()`
- `schedule_remove({ id: "daily" })`

---

## 🌐 HTTP File Server

Serve a directory over HTTP:
```bash
unfold({ task: "serve C:/myfolder on port 8080" })
```

Commands:
- `http_serve({ directory: "./", port: 8080 })`
- `http_serve_stop({ port: 8080 })`

---

## 📊 SQLite Database

Persistent structured storage via `sql.js`:

```bash
unfold({ task: "create a table 'tasks' with id, title, status columns" })
```

Commands:
- `db_exec({ sql: "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT)" })`
- `db_query({ sql: "SELECT * FROM tasks" })`
- `db_tables()`
- `db_export()`

---

## 🔍 Environment Variables

Access system env vars:
```bash
unfold({ task: "list all environment variables" })
```

Commands:
- `env_list()`
- `env_get({ key: "HOME" })`

---

## 🐙 Process Management

```bash
unfold({ task: "show running processes" })
```

Commands:
- `processes({ filter: "chrome" })`
- `process_kill({ pid: 12345 })`
- `sysinfo({ sections: ["cpu", "mem", "disk", "os"] })`

---

## 📋 Clipboard

```bash
unfold({ task: "read the clipboard" })
```

Commands:
- `clipboard_read()`
- `clipboard_write({ text: "Hello World" })`

---

## 🎨 System Information

```bash
unfold({ task: "show CPU, memory, disk, and OS info" })
```

---

## 🧪 Testing

```bash
npm test  # Currently outputs "Error: no test specified"
```

To add tests, create a `test/` directory with Jest or Vitest.

---

## 🛡️ License

All software is the property of ZCHG.org pursuant to:
https://zchg.org/t/legal-notice-copyright-applicable-ip-and-licensing-read-me/440

This repo does not have the authority to usurp its parent licensing.
To purchase licensing, write to: charg.chg.wecharg@gmail.com

---

## 📚 Dependencies

Key packages (from `node_modules`):
- `@modelcontextprotocol/sdk` — MCP protocol
- `express` — HTTP server
- `playwright` — Browser automation
- `systeminformation` — System info
- `sql.js` — SQLite in browser/Node
- `node-telegram-bot-api` — Telegram integration
- `nodemailer` — Email sending
- `node-cron` — Scheduled jobs
- `clipboardy` — Clipboard access

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## 🆘 Support

- Issues: Report bugs on GitHub
- Questions: Ask in discussions
- Features: Propose ideas for new tools

---

**Built with ❤️ by the Wu-Wei team**

*Inspired by "Flow like a river, not like a dam"*
