# 🧠 local-mcp v3.0.0 — Wu-Wei Unfold Architecture

A fully local MCP server with **57 tools across 14 capability groups**.  
No cloud. No telemetry. No external APIs (unless you configure Telegram/SMTP).

![MCP Server](https://github.com/user-attachments/assets/1a64bc98-8903-4391-8caf-eb00469adab7)

## ✨ What Makes This Special

- **🌊 Stream Pipeline Architecture** — Tasks flow through passes like a river (not a dam)
- **🧠 Elegant Recursive Ledger (ERL v3)** — Hash-chained, git-like commit history with branch/merge support
- **🔧 57 Primitives** — From shell commands to browser automation, SQLite, Telegram bots, and more
- **💾 Three Persistence Layers** — Memory (session), Notes (markdown), Database (SQLite)
- **🎯 Automatic Strategy Selection** — `unfold()` analyzes tasks and pipelines the right operations

---

## 🚀 Quick Start

```bash
npm install
node server.js
```

**Connect to:** `http://localhost:3333/sse`  
**Or drop** `mcp.json` into your LM Studio MCP config.

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

A Git-like, hash-chained commit history built into the server:

- **Hash-chain:** Each entry's ID is SHA-256(parentID + timestamp + branch + content)
- **Branches:** Diverge from any entry, tracked by name
- **Merging:** Linear replay of entries from source to target branch
- **Verification:** Full cryptographic verification of any branch
- **Persistence:** Saved to `erl-ledger.json` on every write

**Access via tools:**
- `unfold({ task: "show last 10 ledger entries" })` → uses `erlHistory`
- `unfold({ task: "search ledger for 'error'" })` → uses `erlSearch`
- `unfold({ task: "merge branch 'dev' into main" })` → uses `erlMerge`

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
