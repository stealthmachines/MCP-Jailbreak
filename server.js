#!/usr/bin/env node
/**
 * LOCAL MCP SERVER  v2.0.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Full agentic MCP capability — 100% local, zero telemetry.
 * SSE endpoint: http://localhost:3333/sse
 *
 * TOOL GROUPS:
 *   Shell        shell, shell_stream
 *   Filesystem   fs_read, fs_write, fs_list, fs_delete, fs_stat, fs_search
 *   Browser      browser_open, browser_navigate, browser_click,
 *                browser_fill, browser_screenshot, browser_extract, browser_close
 *   Code         code_exec
 *   Database     db_query, db_exec, db_tables, db_export
 *   Notes        notes_write, notes_read, notes_list, notes_delete, notes_search
 *   Web          web_fetch
 *   System       sysinfo, processes, process_kill, screenshot, clipboard_read,
 *                clipboard_write, notify
 *   Network      http_serve, http_serve_stop
 *   Schedule     schedule_add, schedule_list, schedule_remove
 *   Email        smtp_send
 *   Telegram     tg_send, tg_listen, tg_stop, tg_inbox
 *   Memory       memory_set, memory_get, memory_list, memory_delete
 *   Env          env_get, env_list
 *   Process      process_info
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import http from "http";
import https from "https";
import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { promisify } from "util";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const execAsync = promisify(exec);
const PORT = parseInt(process.env.MCP_PORT || "3333");
const LOG_FILE = process.env.MCP_LOG || path.join(process.cwd(), "mcp-audit.log");
const DB_FILE  = process.env.MCP_DB   || path.join(process.cwd(), "mcp-data.db");
const NOTES_DIR = process.env.MCP_NOTES || path.join(process.cwd(), "notes");
const IS_WIN = process.platform === "win32";

// ── Lazy-loaded heavy modules ─────────────────────────────────────────────────
let _playwright = null;
let _si         = null;
let _notifier   = null;
let _cron       = null;
let _nodemailer = null;
let _TgBot      = null;
let _clipboardy = null;
let _SQL        = null;

async function getPlaywright()  { return _playwright  ||= (await import("playwright")).chromium; }
async function getSI()          { return _si          ||= require("systeminformation"); }
async function getNotifier()    { return _notifier    ||= require("node-notifier"); }
async function getCron()        { return _cron        ||= require("node-cron"); }
async function getMailer()      { return _nodemailer  ||= require("nodemailer"); }
async function getTgBot()       { return _TgBot       ||= require("node-telegram-bot-api"); }
async function getClipboard()   { return _clipboardy  ||= (await import("clipboardy")); }
async function getSQL() {
  if (!_SQL) {
    const initSqlJs = (await import("sql.js")).default;
    _SQL = await initSqlJs();
  }
  return _SQL;
}

// ── Audit logger ──────────────────────────────────────────────────────────────
function auditLog(tool, args, result) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    args: JSON.stringify(args).slice(0, 300),
    ok: !result?.isError,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// ── In-memory KV ──────────────────────────────────────────────────────────────
const memory = {};

// ── SQLite (sql.js, pure JS) ──────────────────────────────────────────────────
let sqlDb = null;
function getDb() {
  // NOTE: sql.js keeps DB in memory; we persist manually
  return sqlDb;
}
async function initDb() {
  const SQL = await getSQL();
  if (fs.existsSync(DB_FILE)) {
    const data = fs.readFileSync(DB_FILE);
    sqlDb = new SQL.Database(data);
  } else {
    sqlDb = new SQL.Database();
  }
}
function saveDb() {
  if (!sqlDb) return;
  const data = sqlDb.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// ── Notes store ───────────────────────────────────────────────────────────────
fs.mkdirSync(NOTES_DIR, { recursive: true });

// ── Browser sessions ──────────────────────────────────────────────────────────
const browsers = new Map();  // sessionId → { browser, page }

// ── Scheduled jobs ────────────────────────────────────────────────────────────
const scheduledJobs = new Map(); // id → { job, expression, command, description }

// ── HTTP file servers ─────────────────────────────────────────────────────────
const fileServers = new Map(); // port → server

// ── Telegram bots ─────────────────────────────────────────────────────────────
const tgBots = new Map();    // token → bot
const tgInbox = new Map();   // token → [messages]

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [

  // ── SHELL ──────────────────────────────────────────────────────────────────
  {
    name: "shell",
    description: "Execute any shell command. Returns stdout, stderr, exit_code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd:     { type: "string" },
        timeout: { type: "number", description: "ms, default 30000" },
        env:     { type: "object" },
      },
      required: ["command"],
    },
  },
  {
    name: "shell_stream",
    description: "Run a command and collect all output. Good for long-running processes.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, cwd: { type: "string" } },
      required: ["command"],
    },
  },

  // ── FILESYSTEM ─────────────────────────────────────────────────────────────
  {
    name: "fs_read",
    description: "Read a file and return its text content.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, encoding: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "fs_write",
    description: "Write or append to a file. Creates parent dirs automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string" },
        content: { type: "string" },
        append:  { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "fs_list",
    description: "List directory contents.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
    },
  },
  {
    name: "fs_delete",
    description: "Delete a file or directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
    },
  },
  {
    name: "fs_stat",
    description: "Get file metadata: size, type, timestamps, mode.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "fs_search",
    description: "Recursively search files by name pattern or content regex.",
    inputSchema: {
      type: "object",
      properties: {
        directory:       { type: "string" },
        name_pattern:    { type: "string", description: "Glob-style filename pattern" },
        content_pattern: { type: "string", description: "Regex to search inside files" },
        max_results:     { type: "number", description: "Default 100" },
      },
      required: ["directory"],
    },
  },

  // ── BROWSER ────────────────────────────────────────────────────────────────
  {
    name: "browser_open",
    description: "Launch a headless Chromium browser session. Returns session_id.",
    inputSchema: {
      type: "object",
      properties: {
        headless: { type: "boolean", description: "Default true" },
        url:      { type: "string",  description: "Optional starting URL" },
      },
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate a browser session to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        url:        { type: "string" },
      },
      required: ["session_id", "url"],
    },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        selector:   { type: "string" },
      },
      required: ["session_id", "selector"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill a form field by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        selector:   { type: "string" },
        value:      { type: "string" },
      },
      required: ["session_id", "selector", "value"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page. Returns base64 PNG.",
    inputSchema: {
      type: "object",
      properties: {
        session_id:  { type: "string" },
        full_page:   { type: "boolean" },
        save_path:   { type: "string", description: "Optional path to save PNG file" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "browser_extract",
    description: "Extract text or HTML from the current page or a specific selector.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        selector:   { type: "string", description: "CSS selector (omit for full body)" },
        mode:       { type: "string", description: "text | html (default text)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "browser_close",
    description: "Close a browser session.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },

  // ── CODE EXECUTION ─────────────────────────────────────────────────────────
  {
    name: "code_exec",
    description: "Execute code in Python, Node.js, or bash. Returns output.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", description: "python | node | bash" },
        code:     { type: "string" },
        timeout:  { type: "number", description: "ms, default 15000" },
      },
      required: ["language", "code"],
    },
  },

  // ── DATABASE ───────────────────────────────────────────────────────────────
  {
    name: "db_query",
    description: "Run a SELECT query on the local SQLite database. Returns rows.",
    inputSchema: {
      type: "object",
      properties: {
        sql:    { type: "string" },
        params: { type: "array" },
      },
      required: ["sql"],
    },
  },
  {
    name: "db_exec",
    description: "Run INSERT/UPDATE/DELETE/CREATE on the local SQLite database.",
    inputSchema: {
      type: "object",
      properties: {
        sql:    { type: "string" },
        params: { type: "array" },
      },
      required: ["sql"],
    },
  },
  {
    name: "db_tables",
    description: "List all tables and their schemas in the local SQLite database.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "db_export",
    description: "Export the entire SQLite database as a JSON dump.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── NOTES ──────────────────────────────────────────────────────────────────
  {
    name: "notes_write",
    description: "Write or append to a named markdown note (persists to disk).",
    inputSchema: {
      type: "object",
      properties: {
        name:    { type: "string", description: "Note filename (without .md)" },
        content: { type: "string" },
        append:  { type: "boolean" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "notes_read",
    description: "Read a named note.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "notes_list",
    description: "List all notes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notes_delete",
    description: "Delete a named note.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "notes_search",
    description: "Search notes by content.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },

  // ── WEB ────────────────────────────────────────────────────────────────────
  {
    name: "web_fetch",
    description: "Fetch any URL. Returns status, headers, body.",
    inputSchema: {
      type: "object",
      properties: {
        url:     { type: "string" },
        method:  { type: "string" },
        headers: { type: "object" },
        body:    { type: "string" },
      },
      required: ["url"],
    },
  },

  // ── SYSTEM ─────────────────────────────────────────────────────────────────
  {
    name: "sysinfo",
    description: "Get system info: CPU, RAM, disk, network, OS, battery.",
    inputSchema: {
      type: "object",
      properties: {
        sections: {
          type: "array",
          description: "Subset of: cpu, mem, disk, network, os, battery, graphics. Omit for all.",
          items: { type: "string" },
        },
      },
    },
  },
  {
    name: "processes",
    description: "List running processes with PID, name, CPU%, memory.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional name filter substring" },
        limit:  { type: "number", description: "Max results, default 50" },
      },
    },
  },
  {
    name: "process_kill",
    description: "Kill a process by PID.",
    inputSchema: {
      type: "object",
      properties: {
        pid:    { type: "number" },
        signal: { type: "string", description: "Signal name, default SIGTERM" },
      },
      required: ["pid"],
    },
  },
  {
    name: "screenshot",
    description: "Take a full screenshot of the primary display. Returns base64 PNG.",
    inputSchema: {
      type: "object",
      properties: {
        save_path: { type: "string", description: "Optional path to save PNG file" },
      },
    },
  },
  {
    name: "clipboard_read",
    description: "Read the current system clipboard text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clipboard_write",
    description: "Write text to the system clipboard.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "notify",
    description: "Send a desktop notification (Windows toast / macOS / Linux).",
    inputSchema: {
      type: "object",
      properties: {
        title:   { type: "string" },
        message: { type: "string" },
        sound:   { type: "boolean" },
      },
      required: ["title", "message"],
    },
  },

  // ── NETWORK ────────────────────────────────────────────────────────────────
  {
    name: "http_serve",
    description: "Serve a local directory over HTTP on a given port.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string" },
        port:      { type: "number" },
      },
      required: ["directory", "port"],
    },
  },
  {
    name: "http_serve_stop",
    description: "Stop a running HTTP file server.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" } },
      required: ["port"],
    },
  },

  // ── SCHEDULE ───────────────────────────────────────────────────────────────
  {
    name: "schedule_add",
    description: "Schedule a shell command to run on a cron expression.",
    inputSchema: {
      type: "object",
      properties: {
        id:          { type: "string",  description: "Unique job ID" },
        expression:  { type: "string",  description: "Cron expression e.g. '*/5 * * * *'" },
        command:     { type: "string",  description: "Shell command to run" },
        description: { type: "string" },
      },
      required: ["id", "expression", "command"],
    },
  },
  {
    name: "schedule_list",
    description: "List all scheduled jobs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_remove",
    description: "Remove a scheduled job by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },

  // ── EMAIL ──────────────────────────────────────────────────────────────────
  {
    name: "smtp_send",
    description: "Send an email via SMTP. Provide SMTP config or use env vars.",
    inputSchema: {
      type: "object",
      properties: {
        to:       { type: "string" },
        subject:  { type: "string" },
        body:     { type: "string" },
        html:     { type: "boolean", description: "Treat body as HTML" },
        smtp_host: { type: "string", description: "Default: SMTP_HOST env var" },
        smtp_port: { type: "number", description: "Default: SMTP_PORT env var or 587" },
        smtp_user: { type: "string", description: "Default: SMTP_USER env var" },
        smtp_pass: { type: "string", description: "Default: SMTP_PASS env var" },
        from:      { type: "string", description: "Default: smtp_user" },
      },
      required: ["to", "subject", "body"],
    },
  },

  // ── TELEGRAM ───────────────────────────────────────────────────────────────
  {
    name: "tg_send",
    description: "Send a Telegram message via a bot token to a chat_id.",
    inputSchema: {
      type: "object",
      properties: {
        token:    { type: "string", description: "Bot token (or use TG_BOT_TOKEN env var)" },
        chat_id:  { type: "string", description: "Chat or user ID to send to" },
        message:  { type: "string" },
        parse_mode: { type: "string", description: "Markdown | HTML (optional)" },
      },
      required: ["chat_id", "message"],
    },
  },
  {
    name: "tg_listen",
    description: "Start listening for incoming Telegram messages on a bot token.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Bot token (or use TG_BOT_TOKEN env var)" },
      },
    },
  },
  {
    name: "tg_inbox",
    description: "Read queued incoming Telegram messages received since last check.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Bot token (or use TG_BOT_TOKEN env var)" },
        limit: { type: "number", description: "Max messages to return, default 20" },
      },
    },
  },
  {
    name: "tg_stop",
    description: "Stop the Telegram bot listener.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
      },
    },
  },

  // ── MEMORY ─────────────────────────────────────────────────────────────────
  {
    name: "memory_set",
    description: "Store a value in the in-memory KV store.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: {} },
      required: ["key", "value"],
    },
  },
  {
    name: "memory_get",
    description: "Retrieve a value from the in-memory KV store.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "memory_list",
    description: "List all keys in the in-memory KV store.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_delete",
    description: "Delete a key from the in-memory KV store.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },

  // ── BRIEFING ───────────────────────────────────────────────────────────────
  {
    name: "get_briefing",
    description: "CALL THIS FIRST. Returns a full orientation briefing: what environment you are in, which tools are callable, what is globally available on the host, and how to act effectively. Always call this at the start of a session before attempting any task.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── CONTEXT ────────────────────────────────────────────────────────────────
  {
    name: "get_context",
    description: [
      "⚡ CALL THIS FIRST before any other tool. Returns empirically verified facts about this",
      "environment: which shell commands actually work, which global tools are available (node,",
      "python, ffmpeg, whisper, git, curl, wget, etc.), the real working directory, OS, PATH,",
      "and capability flags. Use this to avoid calling tools that will fail. The context is",
      "re-probed live each time so it is always accurate.",
    ].join(" "),
    inputSchema: { type: "object", properties: {} },
  },

  // ── ENV / PROCESS ──────────────────────────────────────────────────────────
  {
    name: "env_get",
    description: "Get an environment variable value.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "env_list",
    description: "List all environment variable names.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "process_info",
    description: "Return this server's process info: pid, cwd, uptime, memory.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function shellExec(command, opts = {}) {
  const { cwd, timeout = 30000, env = {} } = opts;
  return execAsync(command, {
    cwd: cwd || process.cwd(),
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    shell: IS_WIN ? true : "/bin/bash",
    env: { ...process.env, ...env },
  });
}

function walkDir(dir, recursive, results = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    results.push({ name: e.name, path: full, type: e.isDirectory() ? "dir" : "file" });
    if (recursive && e.isDirectory()) walkDir(full, true, results);
  }
  return results;
}

function getTgToken(args) {
  const token = args.token || process.env.TG_BOT_TOKEN;
  if (!token) throw new Error("No Telegram token. Pass token arg or set TG_BOT_TOKEN env var.");
  return token;
}

function getOrCreateBot(token) {
  if (tgBots.has(token)) return tgBots.get(token);
  return null;
}

// ── Environment probe ─────────────────────────────────────────────────────────
async function probe(cmd) {
  try {
    const { stdout } = await execAsync(cmd, {
      timeout: 5000,
      shell: IS_WIN ? true : "/bin/bash",
      env: process.env,
    });
    return stdout.trim() || "ok";
  } catch {
    return null;
  }
}

async function probeEnvironment() {
  const IS_WIN = process.platform === "win32";

  // Which command checks a tool is available?
  const which = IS_WIN ? "where" : "which";

  // Probe all tools in parallel
  const [
    nodeVer, npmVer, pythonVer, python3Ver, pipVer,
    gitVer, curlVer, wgetVer, ffmpegVer, whisperVer,
    chocVer, wingetVer, pwshVer,
    shellPath, cwd, whoami, hostname,
  ] = await Promise.all([
    probe("node --version"),
    probe("npm --version"),
    probe("python --version"),
    probe("python3 --version"),
    probe("pip --version"),
    probe("git --version"),
    probe("curl --version"),
    probe("wget --version"),
    probe("ffmpeg -version"),
    probe(`${which} whisper`),
    probe("choco --version"),
    probe("winget --version"),
    probe("pwsh --version"),
    probe(IS_WIN ? "echo %COMSPEC%" : "echo $SHELL"),
    probe(IS_WIN ? "cd" : "pwd"),
    probe(IS_WIN ? "whoami" : "whoami"),
    probe(IS_WIN ? "hostname" : "hostname"),
  ]);

  // Detect python binary
  const pythonBin = python3Ver ? "python3" : (pythonVer ? "python" : null);

  // Probe pip packages if python available
  let pipPackages = null;
  if (pythonBin) {
    pipPackages = await probe(`${pythonBin} -m pip list --format=columns 2>/dev/null | head -40`);
  }

  // Probe npm global packages
  const npmGlobals = await probe("npm list -g --depth=0 2>/dev/null");

  // Probe PATH
  const pathVal = process.env.PATH || process.env.Path || "";

  const available = {
    node:    nodeVer,
    npm:     npmVer,
    python:  python3Ver || pythonVer,
    pip:     pipVer,
    git:     gitVer,
    curl:    curlVer ? curlVer.split("\n")[0] : null,
    wget:    wgetVer ? wgetVer.split("\n")[0] : null,
    ffmpeg:  ffmpegVer ? ffmpegVer.split("\n")[0] : null,
    whisper: whisperVer,
    choco:   chocVer,
    winget:  wingetVer,
    pwsh:    pwshVer,
  };

  const missing = Object.entries(available).filter(([,v]) => !v).map(([k]) => k);
  const present = Object.entries(available).filter(([,v]) => !!v).map(([k,v]) => ({ tool: k, version: v }));

  const context = {
    generated_at: new Date().toISOString(),
    server_version: "2.0.0",

    // ── Host environment ────────────────────────────────────────────────────
    host: {
      os: process.platform,
      arch: process.arch,
      hostname,
      whoami,
      cwd,
      shell: shellPath,
      node_version: process.version,
      is_windows: IS_WIN,
    },

    // ── What works ──────────────────────────────────────────────────────────
    tools_available: present,
    tools_missing: missing,

    // ── Shell guidance ──────────────────────────────────────────────────────
    shell_guidance: {
      use_for_commands: IS_WIN ? "cmd.exe via shell tool (shell:true)" : "/bin/bash via shell tool",
      python_binary: pythonBin,
      pip_install: pythonBin ? `${pythonBin} -m pip install <pkg>` : null,
      download_binary_file: curlVer
        ? `shell: curl -L -o <dest> <url>`
        : (wgetVer ? `shell: wget -O <dest> <url>` : "web_fetch (text only — binary may corrupt)"),
      run_python_script: pythonBin ? `code_exec with language=python` : null,
      run_node_script: nodeVer ? `code_exec with language=node` : null,
    },

    // ── MCP tool capabilities ───────────────────────────────────────────────
    mcp_tools: {
      shell: "✓ Full shell access — use for curl, ffmpeg, whisper, git, etc.",
      shell_stream: "✓ Long-running commands — use for installs, conversions, transcriptions",
      fs_read: "✓ Read any file as text",
      fs_write: "✓ Write any file (binary via base64 not supported — use shell+curl)",
      fs_list: "✓ List directories",
      fs_search: "✓ Recursive filename/content search",
      web_fetch: "✓ HTTP fetch — text/JSON only. For binary files use shell+curl instead.",
      code_exec: nodeVer || pythonBin ? `✓ Run code: ${[nodeVer && "node", pythonBin && "python", "bash"].filter(Boolean).join(", ")}` : "⚠ No runtimes detected",
      browser_open: "✓ Headless Chromium (requires: npx playwright install chromium)",
      db_query: "✓ SQLite SELECT",
      db_exec: "✓ SQLite INSERT/UPDATE/DELETE/CREATE",
      notes_write: "✓ Persistent markdown notes",
      memory_set: "✓ In-process KV (lost on restart — use db_ for persistence)",
      tg_send: "✓ Telegram send (needs TG_BOT_TOKEN)",
      tg_listen: "✓ Telegram receive (needs TG_BOT_TOKEN)",
      smtp_send: "✓ Email (needs SMTP_HOST/USER/PASS env vars)",
      schedule_add: "✓ Cron jobs",
      sysinfo: "✓ CPU/RAM/disk/network stats",
      screenshot: IS_WIN ? "✓ Windows screenshot via PowerShell" : "✓ Screenshot (needs scrot or imagemagick)",
      clipboard_read: "✓ Read clipboard",
      clipboard_write: "✓ Write clipboard",
      notify: "✓ Desktop notification",
    },

    // ── Common task recipes ─────────────────────────────────────────────────
    recipes: {
      download_mp3: curlVer
        ? `shell({ command: "curl -L -o C:/tmp/file.mp3 \\"<url>\\"" })`
        : `shell({ command: "Invoke-WebRequest -Uri '<url>' -OutFile 'C:/tmp/file.mp3'" })`,
      transcribe_audio: whisperVer
        ? `shell({ command: "whisper C:/tmp/file.mp3 --language en" })`
        : "whisper not found — install with: pip install openai-whisper",
      convert_audio: ffmpegVer
        ? `shell({ command: "ffmpeg -i input.mp3 output.wav" })`
        : "ffmpeg not found — install with: choco install ffmpeg OR winget install ffmpeg",
      install_python_pkg: pythonBin
        ? `shell({ command: "${pythonBin} -m pip install <package>" })`
        : "python not found in PATH",
      git_clone: gitVer
        ? `shell({ command: "git clone <repo> <dir>" })`
        : "git not found in PATH",
      run_script: `code_exec({ language: "python", code: "print('hello')" })`,
      persist_data: `db_exec({ sql: "CREATE TABLE IF NOT EXISTS kv (key TEXT, value TEXT)" })`,
    },

    // ── Known limitations ───────────────────────────────────────────────────
    limitations: [
      "web_fetch returns text only — use shell+curl for binary/MP3/ZIP downloads",
      "fs_write is text only — binary files must be written via shell commands",
      "browser tools require: npx playwright install chromium (one-time ~150MB download)",
      "memory_* is cleared on server restart — use db_* or notes_* for persistence",
      "smtp_send requires SMTP_HOST, SMTP_USER, SMTP_PASS environment variables",
      "tg_* requires TG_BOT_TOKEN environment variable or token passed as argument",
      IS_WIN
        ? "shell uses cmd.exe on Windows — use PowerShell syntax for advanced ops or pass pwsh -Command '...'"
        : "shell uses /bin/bash",
    ].filter(Boolean),

    npm_globals: npmGlobals,
    pip_packages: pipPackages,
    path_entries: pathVal.split(IS_WIN ? ";" : ":").filter(Boolean),
  };

  // Write to disk so the agent can also read it via fs_read
  const ctxPath = path.join(process.cwd(), "SYSTEM_CONTEXT.json");
  fs.writeFileSync(ctxPath, JSON.stringify(context, null, 2));

  return context;
}

// ── Tool implementations ──────────────────────────────────────────────────────
async function callTool(name, args = {}) {
  switch (name) {

    // ── SHELL ────────────────────────────────────────────────────────────────
    case "shell": {
      try {
        const { stdout, stderr } = await shellExec(args.command, args);
        return { exit_code: 0, stdout, stderr };
      } catch (e) {
        return { exit_code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
      }
    }

    case "shell_stream": {
      const { command, cwd } = args;
      return new Promise((resolve) => {
        const lines = [];
        const proc = IS_WIN
          ? spawn("cmd.exe", ["/c", command], { cwd: cwd || process.cwd(), stdio: ["ignore","pipe","pipe"] })
          : spawn("/bin/bash", ["-c", command], { cwd: cwd || process.cwd(), stdio: ["ignore","pipe","pipe"] });
        proc.stdout.on("data", d => lines.push(`[out] ${d.toString().trimEnd()}`));
        proc.stderr.on("data", d => lines.push(`[err] ${d.toString().trimEnd()}`));
        proc.on("close", code => resolve({ exit_code: code, output: lines.join("\n") }));
        proc.on("error", e => resolve({ exit_code: 1, output: e.message }));
      });
    }

    // ── FILESYSTEM ───────────────────────────────────────────────────────────
    case "fs_read": {
      const content = fs.readFileSync(args.path, args.encoding || "utf8");
      return { path: args.path, content, bytes: Buffer.byteLength(content) };
    }

    case "fs_write": {
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      args.append ? fs.appendFileSync(args.path, args.content) : fs.writeFileSync(args.path, args.content);
      return { path: args.path, bytes: Buffer.byteLength(args.content), action: args.append ? "appended" : "written" };
    }

    case "fs_list":
      return { path: args.path, entries: walkDir(args.path, args.recursive || false) };

    case "fs_delete":
      args.recursive ? fs.rmSync(args.path, { recursive: true, force: true }) : fs.unlinkSync(args.path);
      return { deleted: args.path };

    case "fs_stat": {
      const s = fs.statSync(args.path);
      return {
        path: args.path,
        type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
        size_bytes: s.size,
        created: s.birthtime.toISOString(),
        modified: s.mtime.toISOString(),
        mode: s.mode.toString(8),
      };
    }

    case "fs_search": {
      const { directory, name_pattern, content_pattern, max_results = 100 } = args;
      const nameRe  = name_pattern    ? new RegExp(name_pattern.replace(/\*/g, ".*"), "i") : null;
      const contentRe = content_pattern ? new RegExp(content_pattern, "i") : null;
      const results = [];

      function search(dir) {
        if (results.length >= max_results) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= max_results) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { search(full); continue; }
          if (nameRe && !nameRe.test(e.name)) continue;
          if (contentRe) {
            try {
              const text = fs.readFileSync(full, "utf8");
              const match = text.match(contentRe);
              if (!match) continue;
              results.push({ path: full, match: match[0] });
            } catch { continue; }
          } else {
            results.push({ path: full });
          }
        }
      }
      search(directory);
      return { results, count: results.length };
    }

    // ── BROWSER ──────────────────────────────────────────────────────────────
    case "browser_open": {
      const chromium = await getPlaywright();
      const browser = await chromium.launch({ headless: args.headless !== false });
      const page = await browser.newPage();
      const sid = `browser_${Date.now()}`;
      browsers.set(sid, { browser, page });
      if (args.url) await page.goto(args.url, { waitUntil: "domcontentloaded" });
      return { session_id: sid, url: page.url() };
    }

    case "browser_navigate": {
      const { page } = browsers.get(args.session_id) || {};
      if (!page) throw new Error("Browser session not found: " + args.session_id);
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    }

    case "browser_click": {
      const { page } = browsers.get(args.session_id) || {};
      if (!page) throw new Error("Browser session not found");
      await page.click(args.selector);
      return { clicked: args.selector };
    }

    case "browser_fill": {
      const { page } = browsers.get(args.session_id) || {};
      if (!page) throw new Error("Browser session not found");
      await page.fill(args.selector, args.value);
      return { filled: args.selector, value: args.value };
    }

    case "browser_screenshot": {
      const { page } = browsers.get(args.session_id) || {};
      if (!page) throw new Error("Browser session not found");
      const buf = await page.screenshot({ fullPage: args.full_page || false });
      const b64 = buf.toString("base64");
      if (args.save_path) fs.writeFileSync(args.save_path, buf);
      return { base64_png: b64, saved_to: args.save_path || null, size_bytes: buf.length };
    }

    case "browser_extract": {
      const { page } = browsers.get(args.session_id) || {};
      if (!page) throw new Error("Browser session not found");
      const mode = args.mode || "text";
      let content;
      if (args.selector) {
        content = mode === "html"
          ? await page.$eval(args.selector, el => el.innerHTML)
          : await page.$eval(args.selector, el => el.innerText);
      } else {
        content = mode === "html"
          ? await page.content()
          : await page.evaluate(() => document.body.innerText);
      }
      return { content, url: page.url() };
    }

    case "browser_close": {
      const session = browsers.get(args.session_id);
      if (!session) throw new Error("Browser session not found");
      await session.browser.close();
      browsers.delete(args.session_id);
      return { closed: args.session_id };
    }

    // ── CODE EXECUTION ───────────────────────────────────────────────────────
    case "code_exec": {
      const { language, code, timeout = 15000 } = args;
      const tmpDir = os.tmpdir();
      let cmd, file;

      if (language === "python") {
        file = path.join(tmpDir, `mcp_exec_${Date.now()}.py`);
        fs.writeFileSync(file, code);
        cmd = `python3 "${file}"`;
      } else if (language === "node") {
        file = path.join(tmpDir, `mcp_exec_${Date.now()}.mjs`);
        fs.writeFileSync(file, code);
        cmd = `node "${file}"`;
      } else if (language === "bash") {
        file = path.join(tmpDir, `mcp_exec_${Date.now()}.sh`);
        fs.writeFileSync(file, code);
        cmd = IS_WIN ? `bash "${file}"` : `bash "${file}"`;
      } else {
        throw new Error(`Unsupported language: ${language}. Use python | node | bash`);
      }

      try {
        const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 5 * 1024 * 1024 });
        return { language, exit_code: 0, stdout, stderr };
      } catch (e) {
        return { language, exit_code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
      } finally {
        if (file) try { fs.unlinkSync(file); } catch {}
      }
    }

    // ── DATABASE ─────────────────────────────────────────────────────────────
    case "db_query": {
      const db = getDb();
      if (!db) throw new Error("Database not initialized");
      const results = db.exec(args.sql, args.params || []);
      if (!results.length) return { rows: [], columns: [] };
      const { columns, values } = results[0];
      return { columns, rows: values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))) };
    }

    case "db_exec": {
      const db = getDb();
      if (!db) throw new Error("Database not initialized");
      db.run(args.sql, args.params || []);
      saveDb();
      return { ok: true, sql: args.sql };
    }

    case "db_tables": {
      const db = getDb();
      if (!db) throw new Error("Database not initialized");
      const results = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'");
      if (!results.length) return { tables: [] };
      const { values } = results[0];
      return { tables: values.map(([name, sql]) => ({ name, schema: sql })) };
    }

    case "db_export": {
      const db = getDb();
      if (!db) throw new Error("Database not initialized");
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'").flatMap(r => r.values.flat());
      const dump = {};
      for (const t of tables) {
        const r = db.exec(`SELECT * FROM "${t}"`);
        if (!r.length) { dump[t] = []; continue; }
        const { columns, values } = r[0];
        dump[t] = values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
      }
      return { tables: dump };
    }

    // ── NOTES ────────────────────────────────────────────────────────────────
    case "notes_write": {
      const file = path.join(NOTES_DIR, `${args.name}.md`);
      args.append ? fs.appendFileSync(file, args.content) : fs.writeFileSync(file, args.content);
      return { note: args.name, action: args.append ? "appended" : "written", bytes: Buffer.byteLength(args.content) };
    }

    case "notes_read": {
      const file = path.join(NOTES_DIR, `${args.name}.md`);
      const content = fs.readFileSync(file, "utf8");
      return { note: args.name, content };
    }

    case "notes_list": {
      const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith(".md"));
      return { notes: files.map(f => f.replace(".md", "")), count: files.length };
    }

    case "notes_delete": {
      fs.unlinkSync(path.join(NOTES_DIR, `${args.name}.md`));
      return { deleted: args.name };
    }

    case "notes_search": {
      const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith(".md"));
      const re = new RegExp(args.query, "i");
      const matches = [];
      for (const f of files) {
        const content = fs.readFileSync(path.join(NOTES_DIR, f), "utf8");
        if (re.test(content)) {
          const excerpt = content.slice(0, 200);
          matches.push({ note: f.replace(".md",""), excerpt });
        }
      }
      return { matches, count: matches.length };
    }

    // ── WEB FETCH ────────────────────────────────────────────────────────────
    case "web_fetch": {
      const { url, method = "GET", headers = {}, body } = args;
      const resp = await fetch(url, { method, headers, body: body || undefined });
      const text = await resp.text();
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      return { url, status: resp.status, ok: resp.ok, headers: respHeaders, body: text };
    }

    // ── SYSTEM ───────────────────────────────────────────────────────────────
    case "sysinfo": {
      const si = await getSI();
      const sections = args.sections || ["cpu", "mem", "disk", "os"];
      const result = {};
      if (sections.includes("cpu"))      result.cpu      = await si.cpu();
      if (sections.includes("mem"))      result.mem      = await si.mem();
      if (sections.includes("disk"))     result.disk     = await si.fsSize();
      if (sections.includes("network"))  result.network  = await si.networkInterfaces();
      if (sections.includes("os"))       result.os       = await si.osInfo();
      if (sections.includes("battery"))  result.battery  = await si.battery();
      if (sections.includes("graphics")) result.graphics = await si.graphics();
      return result;
    }

    case "processes": {
      const si = await getSI();
      const { list } = await si.processes();
      let filtered = list;
      if (args.filter) filtered = filtered.filter(p => p.name.toLowerCase().includes(args.filter.toLowerCase()));
      filtered = filtered.slice(0, args.limit || 50);
      return {
        processes: filtered.map(p => ({
          pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem,
          state: p.state, started: p.started,
        })),
        count: filtered.length,
      };
    }

    case "process_kill": {
      process.kill(args.pid, args.signal || "SIGTERM");
      return { killed: args.pid, signal: args.signal || "SIGTERM" };
    }

    case "screenshot": {
      // Use scrot (Linux), screencapture (macOS), or PowerShell (Windows)
      const outPath = args.save_path || path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
      let cmd;
      if (IS_WIN)                       cmd = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${outPath}') }"`;
      else if (process.platform === "darwin") cmd = `screencapture -x "${outPath}"`;
      else                              cmd = `scrot "${outPath}" 2>/dev/null || import -window root "${outPath}"`;
      await shellExec(cmd);
      const buf = fs.readFileSync(outPath);
      if (!args.save_path) fs.unlinkSync(outPath);
      return { base64_png: buf.toString("base64"), saved_to: args.save_path || null, size_bytes: buf.length };
    }

    case "clipboard_read": {
      const clip = await getClipboard();
      const text = await clip.default.read();
      return { text };
    }

    case "clipboard_write": {
      const clip = await getClipboard();
      await clip.default.write(args.text);
      return { written: true, length: args.text.length };
    }

    case "notify": {
      const notifier = await getNotifier();
      return new Promise((resolve) => {
        notifier.notify({
          title: args.title,
          message: args.message,
          sound: args.sound || false,
        }, (err) => resolve({ sent: !err, error: err?.message }));
      });
    }

    // ── HTTP FILE SERVER ─────────────────────────────────────────────────────
    case "http_serve": {
      const { directory, port } = args;
      if (fileServers.has(port)) throw new Error(`Port ${port} already in use`);
      const srv = http.createServer((req, res) => {
        const filePath = path.join(directory, req.url === "/" ? "index.html" : req.url);
        fs.readFile(filePath, (err, data) => {
          if (err) { res.writeHead(404); res.end("Not found"); return; }
          res.writeHead(200);
          res.end(data);
        });
      });
      srv.listen(port, "127.0.0.1");
      fileServers.set(port, srv);
      return { serving: directory, url: `http://localhost:${port}`, port };
    }

    case "http_serve_stop": {
      const srv = fileServers.get(args.port);
      if (!srv) throw new Error(`No server on port ${args.port}`);
      await new Promise(r => srv.close(r));
      fileServers.delete(args.port);
      return { stopped: args.port };
    }

    // ── SCHEDULE ─────────────────────────────────────────────────────────────
    case "schedule_add": {
      const cron = await getCron();
      const { id, expression, command, description } = args;
      if (scheduledJobs.has(id)) throw new Error(`Job ID '${id}' already exists`);
      const job = cron.schedule(expression, async () => {
        console.log(`[cron] running job '${id}': ${command}`);
        try { await shellExec(command); } catch(e) { console.error(`[cron] job '${id}' failed:`, e.message); }
      });
      scheduledJobs.set(id, { job, expression, command, description: description || "" });
      return { scheduled: id, expression, command };
    }

    case "schedule_list": {
      const jobs = [];
      scheduledJobs.forEach((v, id) => jobs.push({ id, expression: v.expression, command: v.command, description: v.description }));
      return { jobs, count: jobs.length };
    }

    case "schedule_remove": {
      const entry = scheduledJobs.get(args.id);
      if (!entry) throw new Error(`Job '${args.id}' not found`);
      entry.job.destroy();
      scheduledJobs.delete(args.id);
      return { removed: args.id };
    }

    // ── EMAIL ────────────────────────────────────────────────────────────────
    case "smtp_send": {
      const mailer = await getMailer();
      const host = args.smtp_host || process.env.SMTP_HOST;
      const port = args.smtp_port || parseInt(process.env.SMTP_PORT || "587");
      const user = args.smtp_user || process.env.SMTP_USER;
      const pass = args.smtp_pass || process.env.SMTP_PASS;
      if (!host || !user || !pass) throw new Error("SMTP config missing. Set smtp_host/user/pass args or SMTP_HOST/USER/PASS env vars.");
      const transporter = mailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
      const info = await transporter.sendMail({
        from: args.from || user,
        to: args.to,
        subject: args.subject,
        [args.html ? "html" : "text"]: args.body,
      });
      return { sent: true, messageId: info.messageId, to: args.to };
    }

    // ── TELEGRAM ─────────────────────────────────────────────────────────────
    case "tg_send": {
      const TelegramBot = await getTgBot();
      const token = getTgToken(args);
      // Use existing bot if listening, else create one-shot
      let bot = tgBots.get(token);
      let oneShot = false;
      if (!bot) {
        bot = new TelegramBot(token);
        oneShot = true;
      }
      const opts = {};
      if (args.parse_mode) opts.parse_mode = args.parse_mode;
      await bot.sendMessage(args.chat_id, args.message, opts);
      if (oneShot) await bot.close();
      return { sent: true, chat_id: args.chat_id, length: args.message.length };
    }

    case "tg_listen": {
      const TelegramBot = await getTgBot();
      const token = getTgToken(args);
      if (tgBots.has(token)) return { listening: true, note: "Already listening" };
      const bot = new TelegramBot(token, { polling: true });
      tgInbox.set(token, []);
      bot.on("message", (msg) => {
        const inbox = tgInbox.get(token) || [];
        inbox.push({
          id: msg.message_id,
          chat_id: msg.chat.id,
          from: msg.from?.username || msg.from?.first_name || "unknown",
          text: msg.text || "",
          date: new Date(msg.date * 1000).toISOString(),
        });
        // Keep last 500 messages
        if (inbox.length > 500) inbox.splice(0, inbox.length - 500);
        tgInbox.set(token, inbox);
        console.log(`[telegram] msg from ${msg.from?.username}: ${msg.text}`);
      });
      bot.on("polling_error", (e) => console.error("[telegram] polling error:", e.message));
      tgBots.set(token, bot);
      return { listening: true, token: token.slice(0,10) + "..." };
    }

    case "tg_inbox": {
      const token = getTgToken(args);
      const inbox = tgInbox.get(token) || [];
      const limit = args.limit || 20;
      const messages = inbox.splice(0, limit);
      tgInbox.set(token, inbox);
      return { messages, count: messages.length, remaining: inbox.length };
    }

    case "tg_stop": {
      const token = getTgToken(args);
      const bot = tgBots.get(token);
      if (!bot) return { stopped: false, note: "No active bot for this token" };
      await bot.stopPolling();
      tgBots.delete(token);
      tgInbox.delete(token);
      return { stopped: true };
    }

    // ── MEMORY ───────────────────────────────────────────────────────────────
    case "memory_set":
      memory[args.key] = args.value;
      return { key: args.key, stored: true };

    case "memory_get":
      return { key: args.key, value: memory[args.key] ?? null, exists: args.key in memory };

    case "memory_list":
      return { keys: Object.keys(memory), count: Object.keys(memory).length };

    case "memory_delete":
      delete memory[args.key];
      return { key: args.key, deleted: true };

    // ── ENV / PROCESS ────────────────────────────────────────────────────────
    case "env_get":
      return { key: args.key, value: process.env[args.key] ?? null };

    case "env_list":
      return { keys: Object.keys(process.env).sort(), count: Object.keys(process.env).length };

    case "process_info":
      return {
        pid: process.pid, cwd: process.cwd(),
        uptime_s: Math.round(process.uptime()),
        node: process.version, platform: process.platform, arch: process.arch,
        memory: process.memoryUsage(),
        active_browsers: browsers.size,
        active_file_servers: fileServers.size,
        scheduled_jobs: scheduledJobs.size,
        telegram_bots: tgBots.size,
      };

    // ── CONTEXT ──────────────────────────────────────────────────────────────
    case "get_context": {
      return await probeEnvironment();
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "local-mcp", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await callTool(name, args);
      auditLog(name, args, result);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      auditLog(name, args, { isError: true, message: err.message });
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  });
  return server;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "local-mcp", version: "2.0.0", status: "ok",
      uptime_s: Math.round(process.uptime()),
      active_sessions: sessions.size,
      tool_count: TOOLS.length,
      tools: TOOLS.map(t => t.name),
      endpoints: {
        sse:     `http://localhost:${PORT}/sse`,
        message: `http://localhost:${PORT}/message?sessionId=<id>`,
        health:  `http://localhost:${PORT}/health`,
        audit:   `http://localhost:${PORT}/audit`,
      },
    }, null, 2));
    return;
  }

  // Audit log endpoint
  if (url.pathname === "/audit" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const entries = lines.slice(-limit).map(l => JSON.parse(l));
      res.end(JSON.stringify({ entries, total: lines.length }, null, 2));
    } catch {
      res.end(JSON.stringify({ entries: [], total: 0 }));
    }
    return;
  }

  if (url.pathname === "/sse" && req.method === "GET") {
    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport("/message", res);
    const sid = transport.sessionId;
    sessions.set(sid, { transport, server: mcpServer });
    res.on("close", () => {
      sessions.delete(sid);
      console.log(`[-] ${sid}  active: ${sessions.size}`);
    });
    await mcpServer.connect(transport);
    console.log(`[+] ${sid}  active: ${sessions.size}`);
    return;
  }

  if (url.pathname === "/message" && req.method === "POST") {
    const sid = url.searchParams.get("sessionId");
    const session = sessions.get(sid);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found", sessionId: sid }));
      return;
    }
    await session.transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404); res.end("not found");
});

// ── Boot ──────────────────────────────────────────────────────────────────────
await initDb();

// Probe environment at startup and write SYSTEM_CONTEXT.json
console.log("[boot] probing environment...");
const bootCtx = await probeEnvironment();
const presentTools = bootCtx.tools_available.map(t => t.tool).join(", ");
const missingTools = bootCtx.tools_missing.join(", ");
console.log(`[boot] available: ${presentTools || "none"}`);
if (missingTools) console.log(`[boot] missing:   ${missingTools}`);

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`
┌──────────────────────────────────────────────────────┐
│            LOCAL MCP SERVER  v2.0.0                  │
├──────────────────────────────────────────────────────┤
│  SSE    →  http://localhost:${PORT}/sse                 │
│  Health →  http://localhost:${PORT}/health              │
│  Audit  →  http://localhost:${PORT}/audit               │
├──────────────────────────────────────────────────────┤
│  ${TOOLS.length} tools across 14 capability groups:            │
│                                                      │
│  shell        shell · shell_stream                   │
│  filesystem   fs_read/write/list/delete/stat/search  │
│  browser      open·navigate·click·fill·shot·extract  │
│  code         code_exec (python · node · bash)       │
│  database     db_query · db_exec · db_tables         │
│  notes        notes_write/read/list/delete/search    │
│  web          web_fetch                              │
│  system       sysinfo · processes · screenshot       │
│               clipboard · notify · process_kill      │
│  network      http_serve · http_serve_stop           │
│  schedule     schedule_add/list/remove               │
│  email        smtp_send                              │
│  telegram     tg_send · tg_listen · tg_inbox         │
│  memory       memory_set/get/list/delete             │
│  env          env_get · env_list · process_info      │
├──────────────────────────────────────────────────────┤
│  DB   → ${DB_FILE.padEnd(44)} │
│  Notes→ ${NOTES_DIR.padEnd(44)} │
│  Log  → ${LOG_FILE.padEnd(44)} │
└──────────────────────────────────────────────────────┘`);
});

process.on("SIGINT",  () => { console.log("\n[shutdown]"); saveDb(); process.exit(0); });
process.on("SIGTERM", () => { saveDb(); process.exit(0); });
