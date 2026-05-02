<img width="784" height="434" alt="image" src="https://github.com/user-attachments/assets/1a64bc98-8903-4391-8caf-eb00469adab7" />

# local-mcp  v0.3
This readme is out of date and for now, please combine it with the main branch readme for the full picture.

A fully local MCP server with **57 tools across 14 capability groups**.  
No cloud. No telemetry. No external APIs (unless you configure Telegram/SMTP).

## Quick start

```bash
npm install
node server.js
```

Point LM Studio at: **http://localhost:3333/sse**

Or drop `mcp.json` into `C:\Users\<you>\.lmstudio\mcp.json`.

## Configuration

Copy `.env.example` to `.env` and fill in what you need.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PORT` | `3333` | Server port |
| `MCP_LOG` | `./mcp-audit.log` | Audit trail |
| `MCP_DB` | `./mcp-data.db` | SQLite database |
| `MCP_NOTES` | `./notes/` | Notes storage |
| `TG_BOT_TOKEN` | — | Telegram bot token |
| `SMTP_HOST/PORT/USER/PASS` | — | Email credentials |

## Tool groups

| Group | Tools |
|---|---|
| **shell** | shell, shell_stream |
| **filesystem** | fs_read, fs_write, fs_list, fs_delete, fs_stat, fs_search |
| **browser** | browser_open, browser_navigate, browser_click, browser_fill, browser_screenshot, browser_extract, browser_close |
| **code** | code_exec (python, node, bash) |
| **database** | db_query, db_exec, db_tables, db_export |
| **notes** | notes_write, notes_read, notes_list, notes_delete, notes_search |
| **web** | web_fetch |
| **system** | sysinfo, processes, process_kill, screenshot, clipboard_read, clipboard_write, notify |
| **network** | http_serve, http_serve_stop |
| **schedule** | schedule_add, schedule_list, schedule_remove |
| **email** | smtp_send |
| **telegram** | tg_send, tg_listen, tg_inbox, tg_stop |
| **memory** | memory_set, memory_get, memory_list, memory_delete |
| **env** | env_get, env_list, process_info |

## Telegram bot-to-bot

1. Create two bots via [@BotFather](https://t.me/BotFather)
2. Set `TG_BOT_TOKEN` to Bot A's token (or pass inline)
3. Call `tg_listen` — Bot A starts polling
4. Bot B calls `tg_send` to Bot A's chat_id
5. Bot A calls `tg_inbox` to read incoming messages

## Notes

- **Browser:** First use downloads Chromium (~150MB). Pre-fetch with `npx playwright install chromium`
- **SQLite** persists at `mcp-data.db` across restarts
- **Notes** persist at `./notes/*.md`
- **Memory** is in-process only — use db or notes for persistence
- Audit log at `http://localhost:3333/audit`
- Binds to `127.0.0.1` — change to `0.0.0.0` in server.js for LAN access
- To load `.env`: `npm install dotenv` then `node -r dotenv/config server.js`
