#!/usr/bin/env node
/**
 * LOCAL MCP SERVER  v3.0.0  —  Wu-Wei Unfold Architecture
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Inspired by fold26_wuwei_stream.c:
 *
 *   "Flow like a river, not like a dam"
 *
 * ARCHITECTURE:
 *
 *   Instead of exposing parallel tools the agent must choose between,
 *   a single `unfold` entry point accepts a task. The server analyzes it
 *   (like analyze_chunk), selects a pass sequence (like select_chunk_strategy),
 *   and pipelines the work through typed passes — each pass receiving the
 *   previous pass's output as its input, with a FlowState (like StreamState)
 *   carrying continuity across pass boundaries.
 *
 *   agent → unfold(task)
 *             → analyzeTask()           [like analyze_chunk()]
 *             → selectPassSequence()    [like select_chunk_strategy()]
 *             → pass[0](input)          [PASS_FETCH / PASS_SHELL / ...]
 *             → pass[1](pass[0].out)    [PASS_TRANSFORM / PASS_STORE / ...]
 *             → pass[N](pass[N-1].out)  [PASS_NOTIFY / PASS_RESPOND / ...]
 *             → FlowResult
 *
 * PASS TYPES  (mirrors fold26 PassType enum):
 *
 *   FETCH      — web_fetch, file read, download
 *   SHELL      — arbitrary shell command
 *   CODE       — run python/node/bash snippet
 *   TRANSFORM  — ffmpeg, whisper, format conversion
 *   STORE      — fs_write, db_exec, notes_write
 *   RECALL     — fs_read, db_query, notes_read, memory_get
 *   BROWSE     — playwright: navigate, extract, screenshot
 *   NOTIFY     — desktop notification, telegram, email
 *   RESPOND    — terminal pass, formats output for agent
 *
 * FLOW STATE  (mirrors StreamState):
 *
 *   Carries across passes:
 *     cwd, env, last_stdout, last_path, last_url,
 *     browser_session, db_handle, telegram_token,
 *     pass_log[]  (like chunk_header.pass_sequence[])
 *
 * The agent also retains direct access to all primitive tools for cases
 * where a single known operation is needed (like calling deflate directly).
 *
 * SSE endpoint: http://localhost:3333/sse
 */

import { Server }             from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema }
                              from "@modelcontextprotocol/sdk/types.js";

import http       from "http";
import { exec, spawn } from "child_process";
import fs         from "fs";
import path       from "path";
import os         from "os";
import { promisify } from "util";
import { createRequire } from "module";

const require    = createRequire(import.meta.url);
const execAsync  = promisify(exec);
const PORT       = parseInt(process.env.MCP_PORT   || "3333");
const LOG_FILE   = process.env.MCP_LOG    || path.join(process.cwd(), "mcp-audit.log");
const DB_FILE    = process.env.MCP_DB     || path.join(process.cwd(), "mcp-data.db");
const NOTES_DIR  = process.env.MCP_NOTES  || path.join(process.cwd(), "notes");
const IS_WIN     = process.platform === "win32";

fs.mkdirSync(NOTES_DIR, { recursive: true });

// ── Lazy modules (only loaded when a pass needs them) ─────────────────────────
// Mirrors fold26's lazy strategy selection — don't load what you don't need
let _playwright = null, _si = null, _notifier = null,
    _cron = null, _nodemailer = null, _TgBot = null,
    _clipboardy = null, _SQL = null;

const lazy = {
  playwright: async () => _playwright ||= (await import("playwright")).chromium,
  si:         async () => _si         ||= require("systeminformation"),
  notifier:   async () => _notifier   ||= require("node-notifier"),
  cron:       async () => _cron       ||= require("node-cron"),
  mailer:     async () => _nodemailer ||= require("nodemailer"),
  TgBot:      async () => _TgBot      ||= require("node-telegram-bot-api"),
  clipboard:  async () => _clipboardy ||= (await import("clipboardy")),
  SQL: async () => {
    if (!_SQL) { const i = (await import("sql.js")).default; _SQL = await i(); }
    return _SQL;
  },
};

// ── Audit log ─────────────────────────────────────────────────────────────────
function audit(tool, args, ok) {
  fs.appendFileSync(LOG_FILE,
    JSON.stringify({ ts: new Date().toISOString(), tool, args: JSON.stringify(args).slice(0,200), ok }) + "\n"
  );
}

// ── SQLite (persistent) ───────────────────────────────────────────────────────
let sqlDb = null;
async function getDb() {
  if (!sqlDb) {
    const SQL = await lazy.SQL();
    sqlDb = fs.existsSync(DB_FILE)
      ? new SQL.Database(fs.readFileSync(DB_FILE))
      : new SQL.Database();
  }
  return sqlDb;
}
function saveDb() { if (sqlDb) fs.writeFileSync(DB_FILE, Buffer.from(sqlDb.export())); }

// ── In-memory KV ──────────────────────────────────────────────────────────────
const memory = {};

// ── Browser sessions ──────────────────────────────────────────────────────────
const browsers = new Map();

// ── Telegram ──────────────────────────────────────────────────────────────────
const tgBots  = new Map();
const tgInbox = new Map();

// ── Scheduled jobs ────────────────────────────────────────────────────────────
const scheduledJobs = new Map();

// ── File servers ──────────────────────────────────────────────────────────────
const fileServers = new Map();

// ═════════════════════════════════════════════════════════════════════════════
// PASS TYPES  —  mirrors fold26 PassType enum
// ═════════════════════════════════════════════════════════════════════════════
const PASS = {
  FETCH:     "FETCH",      // Acquire data from outside (web, file, download)
  SHELL:     "SHELL",      // Raw shell execution
  CODE:      "CODE",       // Scripted computation (python/node/bash)
  TRANSFORM: "TRANSFORM",  // Data conversion (ffmpeg, whisper, format)
  STORE:     "STORE",      // Persist data (file, db, notes, memory)
  RECALL:    "RECALL",     // Retrieve persisted data
  BROWSE:    "BROWSE",     // Browser automation (playwright)
  NOTIFY:    "NOTIFY",     // Emit signal (desktop, telegram, email)
  RESPOND:   "RESPOND",    // Terminal pass — format final output
};

// ═════════════════════════════════════════════════════════════════════════════
// FLOW STATE  —  mirrors fold26 StreamState
// Carries continuity across pass boundaries, like delta_base + rle_count
// ═════════════════════════════════════════════════════════════════════════════
function newFlowState(seed = {}) {
  return {
    // Execution context (like delta_base — reference point for next pass)
    cwd:            seed.cwd || process.cwd(),
    env:            seed.env || {},

    // Pass output pipe (like current_in/current_out swap buffers)
    data:           seed.data || null,       // Primary data flowing between passes
    data_type:      seed.data_type || "text", // text | binary_path | json | lines

    // Named carry-overs (like rle_value — remembered across boundaries)
    last_path:      seed.last_path || null,
    last_url:       seed.last_url  || null,
    last_stdout:    seed.last_stdout || null,
    last_exit_code: seed.last_exit_code || null,

    // Session handles (persist across passes like zs_initialized)
    browser_session: seed.browser_session || null,
    db_initialized:  false,
    telegram_token:  seed.telegram_token || process.env.TG_BOT_TOKEN || null,

    // Pass log (like chunk_header.pass_sequence[])
    pass_log: [],
    pass_count: 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// TASK ANALYSIS  —  mirrors fold26 analyze_chunk() + DataCharacteristics
// Reads the task string and produces characteristics used to select passes
// ═════════════════════════════════════════════════════════════════════════════
function analyzeTask(task) {
  const t = task.toLowerCase();

  // Signal detection (like entropy, correlation, repetition)
  const signals = {
    // Acquisition signals
    has_url:       /https?:\/\//.test(t),
    has_download:  /download|fetch|get|grab|pull|retrieve/.test(t),
    has_file_read: /read|load|open|cat|show me|contents of/.test(t),
    has_file_ref:  /\.(mp3|wav|mp4|pdf|csv|json|txt|zip|py|js|c|h)\b/.test(t),

    // Transformation signals
    has_audio:     /mp3|wav|aac|flac|ogg|audio|sound|music/.test(t),
    has_video:     /mp4|mkv|avi|video|convert/.test(t),
    has_transcribe:/transcri|whisper|speech|stt/.test(t),
    has_convert:   /convert|transform|encode|decode|format/.test(t),

    // Computation signals
    has_code:      /run|execute|script|python|node|bash|calculate|compute/.test(t),
    has_shell:     /install|npm|pip|git|build|compile|make|mkdir|cp |mv /.test(t),

    // Storage signals
    has_save:      /save|write|store|persist|create file|output to/.test(t),
    has_recall:    /remember|recall|lookup|find in|search|what was|read it back|read back|retrieve it/.test(t),
    has_db:        /database|table|sql|query|insert|record/.test(t),
    has_notes:     /note|notes|remember|journal|log/.test(t),

    // Browse signals
    has_browse:    /browse|navigate|click|fill|screenshot|scrape|selenium/.test(t),
    has_search:    /search for .*(on|in|at|web|internet|google|site)|look up|find on|google/.test(t),

    // Output signals
    has_notify:    /notify|alert|tell me when|ping|message me|telegram|email/.test(t),
    has_telegram:  /telegram|bot|chat/.test(t),
    has_email:     /email|smtp|send mail|mailto/.test(t),

    // Complexity signals
    is_multi_step: /then|after|and then|finally|next|step|and save|and store|and write/.test(t),
    is_question:   /\?|what|how|why|when|where|who/.test(t),
  };

  // Compressibility score (like chars.compressibility) — how much work needed
  let complexity = 0;
  if (signals.has_url)       complexity += 2;
  if (signals.has_download)  complexity += 2;
  if (signals.has_audio || signals.has_video) complexity += 3;
  if (signals.has_transcribe) complexity += 3;
  if (signals.has_code)      complexity += 2;
  if (signals.has_browse)    complexity += 3;
  if (signals.is_multi_step) complexity += 2;

  return { signals, complexity };
}

// ═════════════════════════════════════════════════════════════════════════════
// STRATEGY SELECTION  —  mirrors fold26 select_chunk_strategy()
// Maps task characteristics to a named pass sequence
// Like choosing "Flowing River" vs "Repeated Waves" vs "Non-Action"
// ═════════════════════════════════════════════════════════════════════════════
function selectPassSequence(analysis, task) {
  const { signals, complexity } = analysis;
  const t = task.toLowerCase();

  // ── "Transcription River" ─────────────────────────────────────────────────
  // FETCH → TRANSFORM(ffmpeg) → TRANSFORM(whisper) → STORE → RESPOND
  if (signals.has_download && signals.has_audio && signals.has_transcribe) {
    return {
      name: "Transcription River",
      passes: [PASS.FETCH, PASS.TRANSFORM, PASS.TRANSFORM, PASS.STORE, PASS.RESPOND],
      hints:  ["download", "ffmpeg→wav", "whisper", "notes_write", "summary"],
    };
  }

  // ── "Download and Convert" ────────────────────────────────────────────────
  // FETCH → TRANSFORM → STORE → RESPOND
  if (signals.has_download && (signals.has_audio || signals.has_video || signals.has_convert)) {
    return {
      name: "Download and Convert",
      passes: [PASS.FETCH, PASS.TRANSFORM, PASS.STORE, PASS.RESPOND],
      hints:  ["download", "ffmpeg", "save", "summary"],
    };
  }

  // ── "Browser Quest" ───────────────────────────────────────────────────────
  // BROWSE → [STORE if save] → RESPOND
  // Checked before URL-only strategies — browse intent beats fetch intent
  if (signals.has_browse || signals.has_search) {
    const passes = [PASS.BROWSE];
    if (signals.has_save) passes.push(PASS.STORE);
    passes.push(PASS.RESPOND);
    return {
      name: "Browser Quest",
      passes,
      hints: ["playwright", signals.has_save ? "save" : null, "summary"].filter(Boolean),
    };
  }

  // ── "Web Harvest" ─────────────────────────────────────────────────────────
  // FETCH → [CODE if parse needed] → STORE → RESPOND
  if (signals.has_url && signals.has_save) {
    return {
      name: "Web Harvest",
      passes: [PASS.FETCH, PASS.CODE, PASS.STORE, PASS.RESPOND],
      hints:  ["web_fetch", "parse/extract", "save", "summary"],
    };
  }

  // ── "Pure Fetch" ──────────────────────────────────────────────────────────
  // FETCH → RESPOND
  if (signals.has_url && !signals.has_save && !signals.has_convert) {
    return {
      name: "Pure Fetch",
      passes: [PASS.FETCH, PASS.RESPOND],
      hints:  ["web_fetch", "summary"],
    };
  }

  // ── "Code and Store" ──────────────────────────────────────────────────────
  // CODE → STORE → RESPOND  (must be before Shell Strike — more specific)
  if ((signals.has_code || signals.has_shell) && signals.has_save) {
    return {
      name: "Code and Store",
      passes: [PASS.CODE, PASS.STORE, PASS.RESPOND],
      hints:  ["compute", "save", "summary"],
    };
  }

  // ── "Installation Stream" ─────────────────────────────────────────────────
  // SHELL → SHELL → RESPOND  (multi-step installs)
  if (signals.has_shell && signals.is_multi_step) {
    return {
      name: "Installation Stream",
      passes: [PASS.SHELL, PASS.SHELL, PASS.RESPOND],
      hints:  ["step1", "step2", "verify+report"],
    };
  }

  // ── "Shell Strike" ────────────────────────────────────────────────────────
  // SHELL → RESPOND
  if (signals.has_shell || signals.has_code) {
    return {
      name: "Shell Strike",
      passes: [PASS.SHELL, PASS.RESPOND],
      hints:  ["execute", "result"],
    };
  }

  // ── "Write Then Read" ─────────────────────────────────────────────────────
  // STORE → RECALL → RESPOND  (write file then read it back)
  // Must be before Memory River — has_save+has_recall is more specific than has_recall alone
  if (signals.has_save && (signals.has_recall || signals.has_file_read)) {
    return {
      name: "Write Then Read",
      passes: [PASS.STORE, PASS.RECALL, PASS.RESPOND],
      hints:  ["fs_write", "fs_read", "present"],
    };
  }

  // ── "Memory River" ────────────────────────────────────────────────────────
  // RECALL → [CODE] → RESPOND
  if (signals.has_recall || signals.has_db || signals.has_notes) {
    const passes = [PASS.RECALL];
    if (signals.has_code) passes.push(PASS.CODE);
    passes.push(PASS.RESPOND);
    return {
      name: "Memory River",
      passes,
      hints: ["retrieve", signals.has_code ? "process" : null, "respond"].filter(Boolean),
    };
  }

  // ── "File Read" ───────────────────────────────────────────────────────────
  // RECALL → RESPOND
  if (signals.has_file_read || signals.has_file_ref) {
    return {
      name: "File Read",
      passes: [PASS.RECALL, PASS.RESPOND],
      hints:  ["fs_read", "present"],
    };
  }

  // ── "Notification Wave" ───────────────────────────────────────────────────
  // [optional FETCH/SHELL] → NOTIFY → RESPOND
  if (signals.has_notify) {
    const passes = [];
    if (signals.has_url) passes.push(PASS.FETCH);
    if (signals.has_shell) passes.push(PASS.SHELL);
    passes.push(PASS.NOTIFY, PASS.RESPOND);
    return {
      name: "Notification Wave",
      passes,
      hints: [...passes.map(p => p.toLowerCase())],
    };
  }

  // ── "Non-Action" (like fold26's entropy >= 7.5) ───────────────────────────
  // Just respond with context — no tool work needed
  return {
    name: "Non-Action",
    passes: [PASS.RESPOND],
    hints:  ["direct_response"],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PASS IMPLEMENTATIONS
// Each pass receives the FlowState, executes, and updates state.data
// Like fold26's per-pass encode/decode functions
// ═════════════════════════════════════════════════════════════════════════════

// ── PASS: FETCH ───────────────────────────────────────────────────────────────
async function passFetch(task, hint, state) {
  const urlMatch = task.match(/https?:\/\/[^\s"']+/);

  if (urlMatch) {
    const url = urlMatch[0];
    state.last_url = url;

    // Binary file? Use curl/wget via shell (like fold26 choosing not to gzip already-compressed data)
    const isBinary = /\.(mp3|mp4|wav|zip|gz|tar|pdf|exe|bin)(\?|$)/i.test(url);

    if (isBinary) {
      const fname = path.basename(url.split("?")[0]);
      const dest  = path.join(os.tmpdir(), fname);
      const curlAvail = await probe("curl --version");
      const cmd = curlAvail
        ? `curl -L --progress-bar -o "${dest}" "${url}"`
        : `wget -O "${dest}" "${url}"`;

      const result = await shellExec(cmd);
      state.data      = dest;
      state.data_type = "binary_path";
      state.last_path = dest;
      return { pass: PASS.FETCH, action: "download", url, dest, exit_code: result.exit_code };
    }

    // Text/JSON fetch
    const resp = await fetch(url);
    const text = await resp.text();
    state.data      = text;
    state.data_type = "text";
    state.last_url  = url;
    return { pass: PASS.FETCH, action: "web_fetch", url, status: resp.status, bytes: text.length };
  }

  // File fetch
  if (state.last_path || hint?.includes("file")) {
    const fpath = state.last_path;
    if (fpath && fs.existsSync(fpath)) {
      const content = fs.readFileSync(fpath, "utf8");
      state.data      = content;
      state.data_type = "text";
      return { pass: PASS.FETCH, action: "fs_read", path: fpath, bytes: content.length };
    }
  }

  return { pass: PASS.FETCH, action: "noop", note: "No URL or file path found in task" };
}

// ── PASS: SHELL ───────────────────────────────────────────────────────────────
async function passShell(task, hint, state, passIndex, allPasses) {
  // Extract or construct the command from task + state
  let cmd = extractShellCommand(task, hint, state);

  if (!cmd) {
    return { pass: PASS.SHELL, action: "noop", note: "Could not determine shell command" };
  }

  const result = await shellExec(cmd, { cwd: state.cwd, env: state.env });
  state.last_stdout    = result.stdout;
  state.last_exit_code = result.exit_code;

  // Pipe stdout to data for next pass
  if (result.stdout) {
    state.data      = result.stdout;
    state.data_type = "text";
  }

  return { pass: PASS.SHELL, command: cmd, ...result };
}

// ── PASS: TRANSFORM ───────────────────────────────────────────────────────────
// Like fold26's PASS_DELTA or PASS_RLE — modifies data in-place
async function passTransform(task, hint, state, passIndex) {
  const t = task.toLowerCase();

  // ── Whisper transcription ─────────────────────────────────────────────────
  if (hint?.includes("whisper") || /transcri|speech/.test(t)) {
    const inputPath = state.last_path || state.data;
    if (!inputPath || typeof inputPath !== "string") {
      return { pass: PASS.TRANSFORM, action: "whisper", error: "No audio file path in state" };
    }
    const outDir = path.dirname(inputPath);
    const cmd    = `whisper "${inputPath}" --language en --output_dir "${outDir}"`;
    const result = await shellExec(cmd);
    // Whisper writes <name>.txt
    const txtPath = inputPath.replace(/\.[^.]+$/, ".txt");
    if (fs.existsSync(txtPath)) {
      const transcript = fs.readFileSync(txtPath, "utf8");
      state.data      = transcript;
      state.data_type = "text";
      state.last_path = txtPath;
    }
    return { pass: PASS.TRANSFORM, action: "whisper", input: inputPath, ...result };
  }

  // ── ffmpeg conversion ─────────────────────────────────────────────────────
  if (hint?.includes("ffmpeg") || /ffmpeg|convert|wav|mp3/.test(t)) {
    const inputPath = state.last_path || (state.data_type === "binary_path" ? state.data : null);
    if (!inputPath) {
      return { pass: PASS.TRANSFORM, action: "ffmpeg", error: "No input file in state" };
    }
    const outPath = inputPath.replace(/\.[^.]+$/, ".wav");
    const cmd     = `ffmpeg -y -i "${inputPath}" "${outPath}"`;
    const result  = await shellExec(cmd);
    state.last_path = outPath;
    state.data      = outPath;
    state.data_type = "binary_path";
    return { pass: PASS.TRANSFORM, action: "ffmpeg→wav", input: inputPath, output: outPath, ...result };
  }

  // ── Generic shell transform ───────────────────────────────────────────────
  const cmd = extractShellCommand(task, hint, state);
  if (cmd) {
    const result = await shellExec(cmd, { cwd: state.cwd });
    if (result.stdout) { state.data = result.stdout; state.data_type = "text"; }
    return { pass: PASS.TRANSFORM, action: "shell_transform", command: cmd, ...result };
  }

  return { pass: PASS.TRANSFORM, action: "noop", note: "No transform identified" };
}

// ── PASS: CODE ────────────────────────────────────────────────────────────────
async function passCode(task, hint, state) {
  const t = task.toLowerCase();

  // Detect language
  let language = "python";
  if (/\bnode\b|javascript|js/.test(t)) language = "node";
  if (/\bbash\b|shell/.test(t))         language = "bash";

  // If we have data flowing in, pass it to the script via stdin-equivalent
  const inputData = state.data ? `INPUT = ${JSON.stringify(state.data)}\n` : "";

  // Extract inline code block if present
  const codeMatch = task.match(/```[\w]*\n?([\s\S]+?)```/) ||
                    task.match(/`([^`]+)`/);

  let code;
  if (codeMatch) {
    code = codeMatch[1];
  } else if (language === "python" && state.data_type === "text") {
    // Auto-generate a simple extraction/processing script
    code = `${inputData}import sys, json\ndata = INPUT if 'INPUT' in dir() else sys.stdin.read()\nprint(data[:2000])\n`;
  } else {
    return { pass: PASS.CODE, action: "noop", note: "No code block found in task" };
  }

  // Write temp file + execute
  const ext  = { python: "py", node: "mjs", bash: "sh" }[language];
  const tmp  = path.join(os.tmpdir(), `flow_${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, code);

  const bin  = { python: (await probe("python3 --version")) ? "python3" : "python",
                 node: "node", bash: "bash" }[language];
  const result = await shellExec(`${bin} "${tmp}"`, { cwd: state.cwd });
  try { fs.unlinkSync(tmp); } catch {}

  if (result.stdout) { state.data = result.stdout; state.data_type = "text"; }
  state.last_stdout    = result.stdout;
  state.last_exit_code = result.exit_code;

  return { pass: PASS.CODE, language, exit_code: result.exit_code,
           stdout: result.stdout, stderr: result.stderr };
}

// ── PASS: STORE ───────────────────────────────────────────────────────────────
async function passStore(task, hint, state) {
  const t = task.toLowerCase();

  // ── Extract path from task — match last /path/file.ext or quoted path ──────
  // Pattern handles: write "content" to /path/file.txt
  //                  save output to /path/file.txt
  //                  write to /path/file.txt
  const pathInTask = task.match(/(?:to|into|at)\s+["']?(\/?(?:[\w.\-/\\:]+)\.\w+)["']?/i)
    || task.match(/["'](\/?(?:[\w.\-/\\:]+)\.\w+)["']/);

  // If no data in state but content is in the task string, extract it
  if (!state.data) {
    const contentMatch = task.match(/write\s+"([^"]+)"/i) || task.match(/write\s+'([^']+)'/i);
    if (contentMatch) {
      state.data      = contentMatch[1];
      state.data_type = "text";
    } else {
      return { pass: PASS.STORE, action: "noop", note: "No data in state or task to store" };
    }
  }

  // Notes store
  if (/note|journal|remember/.test(t)) {
    const name = `flow_${Date.now()}`;
    const file = path.join(NOTES_DIR, `${name}.md`);
    fs.writeFileSync(file, typeof state.data === "string" ? state.data : JSON.stringify(state.data, null, 2));
    state.last_path = file;
    return { pass: PASS.STORE, action: "notes_write", note: name, bytes: Buffer.byteLength(String(state.data)) };
  }

  // DB store
  if (/database|table|sql|record/.test(t)) {
    const db = await getDb();
    const key = `flow_${Date.now()}`;
    db.run("CREATE TABLE IF NOT EXISTS flow_store (key TEXT, value TEXT, ts TEXT)");
    db.run("INSERT INTO flow_store VALUES (?,?,?)", [key, String(state.data), new Date().toISOString()]);
    saveDb();
    return { pass: PASS.STORE, action: "db_exec", key };
  }

  // File write — use extracted path or generate one
  const outPath = pathInTask
    ? pathInTask[1]
    : path.join(os.tmpdir(), `flow_output_${Date.now()}.txt`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, typeof state.data === "string" ? state.data : JSON.stringify(state.data, null, 2));
  state.last_path = outPath;

  return { pass: PASS.STORE, action: "fs_write", path: outPath, bytes: Buffer.byteLength(String(state.data)) };
}

// ── PASS: RECALL ──────────────────────────────────────────────────────────────
async function passRecall(task, hint, state) {
  const t = task.toLowerCase();

  // File read — extract path
  const pathMatch = task.match(/["']([^"']+\.\w+)["']/) ||
                    task.match(/(?:read|open|cat|load)\s+(\S+\.\w+)/i);

  if (pathMatch || state.last_path) {
    const fpath = pathMatch ? pathMatch[1] : state.last_path;
    if (fs.existsSync(fpath)) {
      const content = fs.readFileSync(fpath, "utf8");
      state.data      = content;
      state.data_type = "text";
      state.last_path = fpath;
      return { pass: PASS.RECALL, action: "fs_read", path: fpath, bytes: content.length };
    }
  }

  // Notes search
  if (/note|journal/.test(t)) {
    const files   = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith(".md"));
    const results = files.map(f => ({
      name: f.replace(".md",""),
      content: fs.readFileSync(path.join(NOTES_DIR, f), "utf8").slice(0, 500),
    }));
    state.data      = JSON.stringify(results);
    state.data_type = "json";
    return { pass: PASS.RECALL, action: "notes_list", count: results.length };
  }

  // DB query
  if (/database|table|sql/.test(t)) {
    const db      = await getDb();
    const sqlMatch = task.match(/SELECT[\s\S]+/i);
    const sql      = sqlMatch ? sqlMatch[0] : "SELECT * FROM flow_store ORDER BY ts DESC LIMIT 10";
    const results  = db.exec(sql);
    state.data      = JSON.stringify(results);
    state.data_type = "json";
    return { pass: PASS.RECALL, action: "db_query", sql };
  }

  // Memory
  const keyMatch = task.match(/memory[:\s]+(\w+)/i);
  if (keyMatch) {
    const val       = memory[keyMatch[1]];
    state.data      = val ? JSON.stringify(val) : null;
    state.data_type = "json";
    return { pass: PASS.RECALL, action: "memory_get", key: keyMatch[1], found: !!val };
  }

  return { pass: PASS.RECALL, action: "noop", note: "No recall target identified" };
}

// ── PASS: BROWSE ──────────────────────────────────────────────────────────────
async function passBrowse(task, hint, state) {
  const chromium = await lazy.playwright();
  const urlMatch = task.match(/https?:\/\/[^\s"']+/) ||
                   (state.last_url ? [state.last_url] : null);

  // Reuse or open session (like keeping z_stream open across chunks)
  let session = state.browser_session ? browsers.get(state.browser_session) : null;
  if (!session) {
    const browser = await chromium.launch({ headless: true });
    const page    = await browser.newPage();
    const sid     = `browser_${Date.now()}`;
    browsers.set(sid, { browser, page });
    state.browser_session = sid;
    session = { browser, page };
  }

  const { page } = session;

  if (urlMatch) {
    await page.goto(urlMatch[0], { waitUntil: "domcontentloaded" });
    state.last_url = urlMatch[0];
  }

  const text = await page.evaluate(() => document.body.innerText);
  state.data      = text;
  state.data_type = "text";

  return { pass: PASS.BROWSE, url: page.url(), title: await page.title(), chars: text.length };
}

// ── PASS: NOTIFY ──────────────────────────────────────────────────────────────
async function passNotify(task, hint, state) {
  const t = task.toLowerCase();
  const summary = state.data
    ? String(state.data).slice(0, 200)
    : "Task complete";

  // Telegram
  if (/telegram|bot/.test(t) && state.telegram_token) {
    const TgBot  = await lazy.TgBot();
    const chatId = task.match(/chat[_\s]?id[:\s]+(\d+)/i)?.[1] ||
                   process.env.TG_CHAT_ID;
    if (chatId) {
      const bot = new TgBot(state.telegram_token);
      await bot.sendMessage(chatId, summary);
      await bot.close();
      return { pass: PASS.NOTIFY, action: "telegram", chat_id: chatId };
    }
  }

  // Email
  if (/email|smtp/.test(t)) {
    const mailer = await lazy.mailer();
    const trans  = mailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || "587"),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const toMatch = task.match(/to\s+([\w.@]+)/i);
    if (toMatch && process.env.SMTP_HOST) {
      await trans.sendMail({ from: process.env.SMTP_USER, to: toMatch[1],
                             subject: "MCP Task Complete", text: summary });
      return { pass: PASS.NOTIFY, action: "email", to: toMatch[1] };
    }
  }

  // Desktop notification (default)
  const notifier = await lazy.notifier();
  return new Promise((resolve) => {
    notifier.notify({ title: "MCP Task Complete", message: summary }, (err) => {
      resolve({ pass: PASS.NOTIFY, action: "desktop", sent: !err });
    });
  });
}

// ── PASS: RESPOND ─────────────────────────────────────────────────────────────
// Terminal pass — like Z_FINISH flush. Formats the final output for the agent.
async function passRespond(task, hint, state, passLog) {
  return {
    pass:       PASS.RESPOND,
    action:     "terminal",
    summary:    buildSummary(state, passLog),
    data:       state.data_type === "text" ? state.data?.slice(0, 4000) : null,
    data_type:  state.data_type,
    last_path:  state.last_path,
    last_url:   state.last_url,
    exit_code:  state.last_exit_code,
    pass_count: passLog.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS ROUTER  —  mirrors fold26's switch(strategy.passes[pass])
// ─────────────────────────────────────────────────────────────────────────────
async function executePass(passType, task, hint, state, passIndex, allPasses) {
  switch (passType) {
    case PASS.FETCH:     return passFetch(task, hint, state);
    case PASS.SHELL:     return passShell(task, hint, state, passIndex, allPasses);
    case PASS.CODE:      return passCode(task, hint, state);
    case PASS.TRANSFORM: return passTransform(task, hint, state, passIndex);
    case PASS.STORE:     return passStore(task, hint, state);
    case PASS.RECALL:    return passRecall(task, hint, state);
    case PASS.BROWSE:    return passBrowse(task, hint, state);
    case PASS.NOTIFY:    return passNotify(task, hint, state);
    case PASS.RESPOND:   return passRespond(task, hint, state, state.pass_log);
    default: return { pass: passType, action: "unknown" };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// UNFOLD  —  the single entry point
// Mirrors compress_stream()/decompress_stream() — the top-level engine
// ═════════════════════════════════════════════════════════════════════════════
async function unfold(task, opts = {}) {
  const startTs = Date.now();

  // 1. Analyze task  (analyze_chunk)
  const analysis = analyzeTask(task);

  // 2. Select pass sequence  (select_chunk_strategy)
  const strategy = selectPassSequence(analysis, task);

  // 3. Initialize flow state  (StreamState)
  const state = newFlowState({
    cwd:            opts.cwd || process.cwd(),
    env:            opts.env || {},
    telegram_token: opts.telegram_token || process.env.TG_BOT_TOKEN,
  });

  const passResults = [];

  console.log(`[unfold] strategy="${strategy.name}" passes=[${strategy.passes.join("→")}]`);

  // 4. Execute passes in sequence  (the chunk loop)
  // Each pass receives state.data from the previous — like current_in/current_out swap
  for (let i = 0; i < strategy.passes.length; i++) {
    const passType = strategy.passes[i];
    const hint     = strategy.hints[i] || null;

    console.log(`[unfold] pass ${i+1}/${strategy.passes.length}: ${passType} (hint: ${hint})`);

    let result;
    try {
      result = await executePass(passType, task, hint, state, i, strategy.passes);
    } catch (err) {
      result = { pass: passType, error: err.message };
      console.error(`[unfold] pass ${passType} error:`, err.message);
    }

    // Log pass result (like chunk_header.pass_sequence[num_passes++])
    state.pass_log.push({ type: passType, hint, ...result });
    passResults.push(result);
    state.pass_count++;

    // If a pass fails catastrophically, check if we should abort
    // (like fold26 checking new_size > 0 before swapping buffers)
    if (result.error && passType !== PASS.RESPOND) {
      console.warn(`[unfold] pass ${passType} failed — continuing to RESPOND`);
      // Inject a terminal RESPOND pass
      const finalResult = await passRespond(task, null, state, state.pass_log);
      passResults.push(finalResult);
      break;
    }
  }

  // 5. Build FlowResult  (GlobalHeader final write)
  return {
    strategy:     strategy.name,
    passes:       strategy.passes,
    pass_results: passResults,
    elapsed_ms:   Date.now() - startTs,
    signals:      analysis.signals,
    complexity:   analysis.complexity,
    final: {
      data:      state.data_type === "text" ? state.data?.slice(0, 4000) : null,
      data_type: state.data_type,
      last_path: state.last_path,
      last_url:  state.last_url,
      exit_code: state.last_exit_code,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PRIMITIVE TOOLS  —  direct access for single-pass operations
// Like calling deflate() directly when you just need one pass
// ═════════════════════════════════════════════════════════════════════════════
async function callPrimitive(name, args = {}) {
  switch (name) {
    case "shell": {
      try {
        const { stdout, stderr } = await shellExec(args.command, args);
        return { exit_code: 0, stdout, stderr };
      } catch(e) { return { exit_code: e.code??1, stdout: e.stdout??"", stderr: e.stderr??e.message }; }
    }
    case "shell_stream": {
      return new Promise((resolve) => {
        const lines = [];
        const proc  = IS_WIN
          ? spawn("cmd.exe", ["/c", args.command], { cwd: args.cwd||process.cwd(), stdio:["ignore","pipe","pipe"] })
          : spawn("/bin/bash", ["-c", args.command], { cwd: args.cwd||process.cwd(), stdio:["ignore","pipe","pipe"] });
        proc.stdout.on("data", d => lines.push(`[out] ${d.toString().trimEnd()}`));
        proc.stderr.on("data", d => lines.push(`[err] ${d.toString().trimEnd()}`));
        proc.on("close", code => resolve({ exit_code: code, output: lines.join("\n") }));
        proc.on("error", e   => resolve({ exit_code: 1,    output: e.message }));
      });
    }
    case "fs_read":   return { content: fs.readFileSync(args.path, args.encoding||"utf8") };
    case "fs_write":
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      args.append ? fs.appendFileSync(args.path, args.content) : fs.writeFileSync(args.path, args.content);
      return { written: args.path };
    case "fs_list":   return { entries: walkDir(args.path, args.recursive||false) };
    case "fs_delete":
      args.recursive ? fs.rmSync(args.path,{recursive:true,force:true}) : fs.unlinkSync(args.path);
      return { deleted: args.path };
    case "fs_stat": {
      const s = fs.statSync(args.path);
      return { type: s.isDirectory()?"dir":"file", size_bytes: s.size,
               modified: s.mtime.toISOString(), mode: s.mode.toString(8) };
    }
    case "fs_search": {
      const results = [];
      const nameRe  = args.name_pattern    ? new RegExp(args.name_pattern.replace(/\*/g,".*"),"i") : null;
      const contRe  = args.content_pattern ? new RegExp(args.content_pattern,"i") : null;
      function search(dir) {
        if (results.length >= (args.max_results||100)) return;
        let entries; try { entries = fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { search(full); continue; }
          if (nameRe && !nameRe.test(e.name)) continue;
          if (contRe) { try { if (!contRe.test(fs.readFileSync(full,"utf8"))) continue; } catch { continue; } }
          results.push({ path: full });
        }
      }
      search(args.directory);
      return { results, count: results.length };
    }
    case "web_fetch": {
      const resp = await fetch(args.url, { method: args.method||"GET", headers: args.headers||{}, body: args.body||undefined });
      const text = await resp.text();
      return { status: resp.status, ok: resp.ok, body: text };
    }
    case "code_exec": {
      const ext  = { python:"py", node:"mjs", bash:"sh" }[args.language] || "sh";
      const bin  = args.language === "python" ? ((await probe("python3 --version")) ? "python3" : "python") : args.language;
      const tmp  = path.join(os.tmpdir(), `mcp_${Date.now()}.${ext}`);
      fs.writeFileSync(tmp, args.code);
      try {
        const { stdout, stderr } = await execAsync(`${bin} "${tmp}"`, { timeout: args.timeout||15000 });
        return { exit_code: 0, stdout, stderr };
      } catch(e) { return { exit_code: e.code??1, stdout: e.stdout??"", stderr: e.stderr??e.message }; }
      finally { try { fs.unlinkSync(tmp); } catch {} }
    }
    case "db_query": {
      const db = await getDb();
      const r  = db.exec(args.sql, args.params||[]);
      if (!r.length) return { rows: [] };
      const { columns, values } = r[0];
      return { columns, rows: values.map(row => Object.fromEntries(columns.map((c,i)=>[c,row[i]]))) };
    }
    case "db_exec": {
      const db = await getDb();
      db.run(args.sql, args.params||[]); saveDb();
      return { ok: true };
    }
    case "db_tables": {
      const db = await getDb();
      const r  = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'");
      return { tables: r.length ? r[0].values.map(([n,s])=>({name:n,schema:s})) : [] };
    }
    case "db_export": {
      const db = await getDb();
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'").flatMap(r=>r.values.flat());
      const dump = {};
      for (const t of tables) {
        const r = db.exec(`SELECT * FROM "${t}"`);
        if (!r.length) { dump[t]=[]; continue; }
        const {columns,values} = r[0];
        dump[t] = values.map(row=>Object.fromEntries(columns.map((c,i)=>[c,row[i]])));
      }
      return { tables: dump };
    }
    case "notes_write": {
      const f = path.join(NOTES_DIR, `${args.name}.md`);
      args.append ? fs.appendFileSync(f, args.content) : fs.writeFileSync(f, args.content);
      return { written: args.name };
    }
    case "notes_read":   return { content: fs.readFileSync(path.join(NOTES_DIR,`${args.name}.md`),"utf8") };
    case "notes_list":   return { notes: fs.readdirSync(NOTES_DIR).filter(f=>f.endsWith(".md")).map(f=>f.replace(".md","")) };
    case "notes_delete": { fs.unlinkSync(path.join(NOTES_DIR,`${args.name}.md`)); return { deleted: args.name }; }
    case "notes_search": {
      const re = new RegExp(args.query,"i");
      return { matches: fs.readdirSync(NOTES_DIR).filter(f=>f.endsWith(".md")).filter(f=>re.test(fs.readFileSync(path.join(NOTES_DIR,f),"utf8"))).map(f=>f.replace(".md","")) };
    }
    case "sysinfo": {
      const si = await lazy.si();
      const r  = {};
      const s  = args.sections || ["cpu","mem","disk","os"];
      if (s.includes("cpu"))  r.cpu  = await si.cpu();
      if (s.includes("mem"))  r.mem  = await si.mem();
      if (s.includes("disk")) r.disk = await si.fsSize();
      if (s.includes("os"))   r.os   = await si.osInfo();
      return r;
    }
    case "processes": {
      const si = await lazy.si();
      const { list } = await si.processes();
      let filtered = list;
      if (args.filter) filtered = filtered.filter(p=>p.name.toLowerCase().includes(args.filter.toLowerCase()));
      return { processes: filtered.slice(0,args.limit||50).map(p=>({pid:p.pid,name:p.name,cpu:p.cpu,mem:p.mem})) };
    }
    case "process_kill": { process.kill(args.pid, args.signal||"SIGTERM"); return { killed: args.pid }; }
    case "clipboard_read":  { const c = await lazy.clipboard(); return { text: await c.default.read() }; }
    case "clipboard_write": { const c = await lazy.clipboard(); await c.default.write(args.text); return { written: true }; }
    case "notify": {
      const n = await lazy.notifier();
      return new Promise(r => n.notify({ title: args.title, message: args.message }, err => r({ sent: !err })));
    }
    case "http_serve": {
      if (fileServers.has(args.port)) throw new Error("Port in use");
      const srv = http.createServer((req,res) => {
        fs.readFile(path.join(args.directory, req.url==="/"?"index.html":req.url),(err,data)=>{
          if (err) { res.writeHead(404); res.end("Not found"); return; }
          res.writeHead(200); res.end(data);
        });
      });
      srv.listen(args.port,"127.0.0.1");
      fileServers.set(args.port, srv);
      return { serving: args.directory, port: args.port };
    }
    case "http_serve_stop": {
      const srv = fileServers.get(args.port);
      if (!srv) throw new Error("No server on port " + args.port);
      await new Promise(r => srv.close(r)); fileServers.delete(args.port);
      return { stopped: args.port };
    }
    case "schedule_add": {
      const cron = await lazy.cron();
      const job  = cron.schedule(args.expression, async () => {
        try { await shellExec(args.command); } catch(e) { console.error("[cron]", e.message); }
      });
      scheduledJobs.set(args.id, { job, expression: args.expression, command: args.command });
      return { scheduled: args.id };
    }
    case "schedule_list": {
      const jobs = [];
      scheduledJobs.forEach((v,id) => jobs.push({ id, expression: v.expression, command: v.command }));
      return { jobs };
    }
    case "schedule_remove": {
      const e = scheduledJobs.get(args.id);
      if (!e) throw new Error("Job not found");
      e.job.destroy(); scheduledJobs.delete(args.id);
      return { removed: args.id };
    }
    case "smtp_send": {
      const m = await lazy.mailer();
      const t = m.createTransport({ host: args.smtp_host||process.env.SMTP_HOST,
        port: args.smtp_port||parseInt(process.env.SMTP_PORT||"587"),
        auth: { user: args.smtp_user||process.env.SMTP_USER, pass: args.smtp_pass||process.env.SMTP_PASS } });
      const info = await t.sendMail({ from: args.from||process.env.SMTP_USER, to: args.to,
                                      subject: args.subject, [args.html?"html":"text"]: args.body });
      return { sent: true, messageId: info.messageId };
    }
    case "tg_send": {
      const TgBot = await lazy.TgBot();
      const token = args.token || process.env.TG_BOT_TOKEN;
      if (!token) throw new Error("No TG_BOT_TOKEN");
      const bot   = tgBots.get(token) || new TgBot(token);
      await bot.sendMessage(args.chat_id, args.message, args.parse_mode ? { parse_mode: args.parse_mode } : {});
      if (!tgBots.has(token)) await bot.close();
      return { sent: true };
    }
    case "tg_listen": {
      const TgBot = await lazy.TgBot();
      const token = args.token || process.env.TG_BOT_TOKEN;
      if (!token) throw new Error("No TG_BOT_TOKEN");
      if (tgBots.has(token)) return { listening: true, note: "Already active" };
      const bot = new TgBot(token, { polling: true });
      tgInbox.set(token, []);
      bot.on("message", msg => {
        const inbox = tgInbox.get(token) || [];
        inbox.push({ id: msg.message_id, chat_id: msg.chat.id,
                     from: msg.from?.username||"unknown", text: msg.text||"",
                     date: new Date(msg.date*1000).toISOString() });
        if (inbox.length > 500) inbox.splice(0, inbox.length-500);
        tgInbox.set(token, inbox);
      });
      tgBots.set(token, bot);
      return { listening: true };
    }
    case "tg_inbox": {
      const token = args.token || process.env.TG_BOT_TOKEN;
      if (!token) throw new Error("No TG_BOT_TOKEN");
      const inbox    = tgInbox.get(token) || [];
      const messages = inbox.splice(0, args.limit||20);
      tgInbox.set(token, inbox);
      return { messages, count: messages.length };
    }
    case "tg_stop": {
      const token = args.token || process.env.TG_BOT_TOKEN;
      const bot   = tgBots.get(token);
      if (!bot) return { stopped: false };
      await bot.stopPolling(); tgBots.delete(token); tgInbox.delete(token);
      return { stopped: true };
    }
    case "memory_set":    memory[args.key] = args.value; return { stored: true };
    case "memory_get":    return { value: memory[args.key]??null, exists: args.key in memory };
    case "memory_list":   return { keys: Object.keys(memory) };
    case "memory_delete": delete memory[args.key]; return { deleted: args.key };
    case "env_get":       return { value: process.env[args.key]??null };
    case "env_list":      return { keys: Object.keys(process.env).sort() };
    case "get_context":   return await getEnvCtx() || await probeEnvironment();
    case "process_info":  return { pid: process.pid, cwd: process.cwd(),
                                   uptime_s: Math.round(process.uptime()),
                                   node: process.version, platform: process.platform,
                                   browsers: browsers.size, jobs: scheduledJobs.size };
    case "browser_open": {
      const chromium = await lazy.playwright();
      const browser  = await chromium.launch({ headless: args.headless!==false });
      const page     = await browser.newPage();
      const sid      = `browser_${Date.now()}`;
      browsers.set(sid, { browser, page });
      if (args.url) await page.goto(args.url, { waitUntil: "domcontentloaded" });
      return { session_id: sid };
    }
    case "browser_navigate": {
      const { page } = browsers.get(args.session_id)||{};
      if (!page) throw new Error("No browser session: " + args.session_id);
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    }
    case "browser_click": {
      const { page } = browsers.get(args.session_id)||{};
      if (!page) throw new Error("No browser session");
      await page.click(args.selector);
      return { clicked: args.selector };
    }
    case "browser_fill": {
      const { page } = browsers.get(args.session_id)||{};
      if (!page) throw new Error("No browser session");
      await page.fill(args.selector, args.value);
      return { filled: args.selector };
    }
    case "browser_screenshot": {
      const { page } = browsers.get(args.session_id)||{};
      if (!page) throw new Error("No browser session");
      const buf = await page.screenshot({ fullPage: args.full_page||false });
      if (args.save_path) fs.writeFileSync(args.save_path, buf);
      return { base64_png: buf.toString("base64"), saved_to: args.save_path||null };
    }
    case "browser_extract": {
      const { page } = browsers.get(args.session_id)||{};
      if (!page) throw new Error("No browser session");
      const content = args.selector
        ? await page.$eval(args.selector, el => el.innerText)
        : await page.evaluate(() => document.body.innerText);
      return { content };
    }
    case "browser_close": {
      const s = browsers.get(args.session_id);
      if (!s) throw new Error("No browser session");
      await s.browser.close(); browsers.delete(args.session_id);
      return { closed: args.session_id };
    }
    default: throw new Error(`Unknown primitive: ${name}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MCP TOOL MANIFEST
// ═════════════════════════════════════════════════════════════════════════════
const TOOLS = [
  // ── PRIMARY ENTRY POINT ───────────────────────────────────────────────────
  {
    name: "unfold",
    description: [
      "⚡ PRIMARY TOOL. Describe any task in natural language.",
      "The server analyzes the task, selects an optimal pass sequence",
      "(FETCH→TRANSFORM→STORE, BROWSE→NOTIFY, SHELL→RESPOND, etc.),",
      "and pipelines execution with shared state flowing between passes —",
      "like a streaming compressor: each pass receives the previous pass's output.",
      "Use this for any multi-step task. Use primitives below only for single known operations.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Natural language description of what to accomplish" },
        cwd:  { type: "string", description: "Working directory (optional)" },
        env:  { type: "object", description: "Extra environment variables (optional)" },
        telegram_token: { type: "string", description: "Telegram bot token override (optional)" },
      },
      required: ["task"],
    },
  },

  // ── CONTEXT ───────────────────────────────────────────────────────────────
  {
    name: "get_context",
    description: "Probe the environment. Call before any session to know what tools, runtimes, and shell commands are actually available.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── PRIMITIVES ────────────────────────────────────────────────────────────
  // Direct access to individual passes for single-operation use
  { name: "shell",          description: "Execute a shell command directly.",
    inputSchema: { type:"object", properties:{ command:{type:"string"}, cwd:{type:"string"}, timeout:{type:"number"}, env:{type:"object"} }, required:["command"] } },
  { name: "shell_stream",   description: "Run a long command and collect all output.",
    inputSchema: { type:"object", properties:{ command:{type:"string"}, cwd:{type:"string"} }, required:["command"] } },
  { name: "fs_read",        description: "Read a file.",
    inputSchema: { type:"object", properties:{ path:{type:"string"}, encoding:{type:"string"} }, required:["path"] } },
  { name: "fs_write",       description: "Write or append to a file.",
    inputSchema: { type:"object", properties:{ path:{type:"string"}, content:{type:"string"}, append:{type:"boolean"} }, required:["path","content"] } },
  { name: "fs_list",        description: "List a directory.",
    inputSchema: { type:"object", properties:{ path:{type:"string"}, recursive:{type:"boolean"} }, required:["path"] } },
  { name: "fs_delete",      description: "Delete a file or directory.",
    inputSchema: { type:"object", properties:{ path:{type:"string"}, recursive:{type:"boolean"} }, required:["path"] } },
  { name: "fs_stat",        description: "Stat a file.",
    inputSchema: { type:"object", properties:{ path:{type:"string"} }, required:["path"] } },
  { name: "fs_search",      description: "Recursive file search by name or content.",
    inputSchema: { type:"object", properties:{ directory:{type:"string"}, name_pattern:{type:"string"}, content_pattern:{type:"string"}, max_results:{type:"number"} }, required:["directory"] } },
  { name: "web_fetch",      description: "Fetch a URL (text/JSON). For binary files use unfold or shell+curl.",
    inputSchema: { type:"object", properties:{ url:{type:"string"}, method:{type:"string"}, headers:{type:"object"}, body:{type:"string"} }, required:["url"] } },
  { name: "code_exec",      description: "Execute python/node/bash code.",
    inputSchema: { type:"object", properties:{ language:{type:"string"}, code:{type:"string"}, timeout:{type:"number"} }, required:["language","code"] } },
  { name: "db_query",       description: "SQLite SELECT.",
    inputSchema: { type:"object", properties:{ sql:{type:"string"}, params:{type:"array"} }, required:["sql"] } },
  { name: "db_exec",        description: "SQLite INSERT/UPDATE/DELETE/CREATE.",
    inputSchema: { type:"object", properties:{ sql:{type:"string"}, params:{type:"array"} }, required:["sql"] } },
  { name: "db_tables",      description: "List SQLite tables.",
    inputSchema: { type:"object", properties:{} } },
  { name: "db_export",      description: "Export SQLite as JSON.",
    inputSchema: { type:"object", properties:{} } },
  { name: "notes_write",    description: "Write a named markdown note.",
    inputSchema: { type:"object", properties:{ name:{type:"string"}, content:{type:"string"}, append:{type:"boolean"} }, required:["name","content"] } },
  { name: "notes_read",     description: "Read a named note.",
    inputSchema: { type:"object", properties:{ name:{type:"string"} }, required:["name"] } },
  { name: "notes_list",     description: "List all notes.",
    inputSchema: { type:"object", properties:{} } },
  { name: "notes_delete",   description: "Delete a note.",
    inputSchema: { type:"object", properties:{ name:{type:"string"} }, required:["name"] } },
  { name: "notes_search",   description: "Search notes by content.",
    inputSchema: { type:"object", properties:{ query:{type:"string"} }, required:["query"] } },
  { name: "sysinfo",        description: "System info: cpu, mem, disk, os.",
    inputSchema: { type:"object", properties:{ sections:{type:"array",items:{type:"string"}} } } },
  { name: "processes",      description: "List running processes.",
    inputSchema: { type:"object", properties:{ filter:{type:"string"}, limit:{type:"number"} } } },
  { name: "process_kill",   description: "Kill a process by PID.",
    inputSchema: { type:"object", properties:{ pid:{type:"number"}, signal:{type:"string"} }, required:["pid"] } },
  { name: "clipboard_read", description: "Read clipboard.",
    inputSchema: { type:"object", properties:{} } },
  { name: "clipboard_write",description: "Write clipboard.",
    inputSchema: { type:"object", properties:{ text:{type:"string"} }, required:["text"] } },
  { name: "notify",         description: "Desktop notification.",
    inputSchema: { type:"object", properties:{ title:{type:"string"}, message:{type:"string"} }, required:["title","message"] } },
  { name: "http_serve",     description: "Serve a directory over HTTP.",
    inputSchema: { type:"object", properties:{ directory:{type:"string"}, port:{type:"number"} }, required:["directory","port"] } },
  { name: "http_serve_stop",description: "Stop an HTTP file server.",
    inputSchema: { type:"object", properties:{ port:{type:"number"} }, required:["port"] } },
  { name: "schedule_add",   description: "Schedule a cron job.",
    inputSchema: { type:"object", properties:{ id:{type:"string"}, expression:{type:"string"}, command:{type:"string"}, description:{type:"string"} }, required:["id","expression","command"] } },
  { name: "schedule_list",  description: "List scheduled jobs.",
    inputSchema: { type:"object", properties:{} } },
  { name: "schedule_remove",description: "Remove a scheduled job.",
    inputSchema: { type:"object", properties:{ id:{type:"string"} }, required:["id"] } },
  { name: "smtp_send",      description: "Send email via SMTP.",
    inputSchema: { type:"object", properties:{ to:{type:"string"}, subject:{type:"string"}, body:{type:"string"}, smtp_host:{type:"string"}, smtp_port:{type:"number"}, smtp_user:{type:"string"}, smtp_pass:{type:"string"} }, required:["to","subject","body"] } },
  { name: "tg_send",        description: "Send a Telegram message.",
    inputSchema: { type:"object", properties:{ token:{type:"string"}, chat_id:{type:"string"}, message:{type:"string"} }, required:["chat_id","message"] } },
  { name: "tg_listen",      description: "Start Telegram bot polling.",
    inputSchema: { type:"object", properties:{ token:{type:"string"} } } },
  { name: "tg_inbox",       description: "Read Telegram inbox.",
    inputSchema: { type:"object", properties:{ token:{type:"string"}, limit:{type:"number"} } } },
  { name: "tg_stop",        description: "Stop Telegram bot.",
    inputSchema: { type:"object", properties:{ token:{type:"string"} } } },
  { name: "memory_set",     description: "Store in memory.",
    inputSchema: { type:"object", properties:{ key:{type:"string"}, value:{} }, required:["key","value"] } },
  { name: "memory_get",     description: "Get from memory.",
    inputSchema: { type:"object", properties:{ key:{type:"string"} }, required:["key"] } },
  { name: "memory_list",    description: "List memory keys.",
    inputSchema: { type:"object", properties:{} } },
  { name: "memory_delete",  description: "Delete from memory.",
    inputSchema: { type:"object", properties:{ key:{type:"string"} }, required:["key"] } },
  { name: "env_get",        description: "Get env var.",
    inputSchema: { type:"object", properties:{ key:{type:"string"} }, required:["key"] } },
  { name: "env_list",       description: "List env var names.",
    inputSchema: { type:"object", properties:{} } },
  { name: "process_info",   description: "Server process info.",
    inputSchema: { type:"object", properties:{} } },
  { name: "browser_open",       description: "Open a browser session.",
    inputSchema: { type:"object", properties:{ headless:{type:"boolean"}, url:{type:"string"} } } },
  { name: "browser_navigate",   description: "Navigate to URL.",
    inputSchema: { type:"object", properties:{ session_id:{type:"string"}, url:{type:"string"} }, required:["session_id","url"] } },
  { name: "browser_click",      description: "Click a CSS selector.",
    inputSchema: { type:"object", properties:{ session_id:{type:"string"}, selector:{type:"string"} }, required:["session_id","selector"] } },
  { name: "browser_fill",       description: "Fill a form field.",
    inputSchema: { type:"object", properties:{ session_id:{type:"string"}, selector:{type:"string"}, value:{type:"string"} }, required:["session_id","selector","value"] } },
  { name: "browser_screenshot", description: "Screenshot current page.",
    inputSchema: { type:"object", properties:{ session_id:{type:"string"}, full_page:{type:"boolean"}, save_path:{type:"string"} }, required:["session_id"] } },
  { name: "browser_extract",    description: "Extract text/HTML from page.",
    inputSchema: { type:"object", properties:{ session_id:{type:"string"}, selector:{type:"string"}, mode:{type:"string"} }, required:["session_id"] } },
  { name: "browser_close",      description: "Close browser session.",
    inputSchema: { type:"object", properties:{ session_id:{type:"string"} }, required:["session_id"] } },
];

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
async function probe(cmd) {
  // Hard 2-second wall-clock kill — prevents Windows PATH searches from hanging
  // execAsync timeout alone isn't enough on Windows; the process can outlive it
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    execAsync(cmd, {
      timeout: 1800,
      shell: IS_WIN ? true : "/bin/bash",
      windowsHide: true,  // suppress cmd.exe flash on Windows
    }).then(({ stdout }) => {
      clearTimeout(timer);
      resolve(stdout.trim() || "ok");
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function shellExec(command, opts = {}) {
  const { cwd, timeout = 30000, env = {} } = opts;
  return execAsync(command, {
    cwd: cwd || process.cwd(), timeout,
    maxBuffer: 10 * 1024 * 1024,
    shell: IS_WIN ? true : "/bin/bash",
    env: { ...process.env, ...env },
  }).then(r => ({ exit_code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch(e => ({ exit_code: e.code??1, stdout: e.stdout??"", stderr: e.stderr??e.message }));
}

function walkDir(dir, recursive, results = []) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      results.push({ name: e.name, path: full, type: e.isDirectory()?"dir":"file" });
      if (recursive && e.isDirectory()) walkDir(full, true, results);
    }
  } catch {}
  return results;
}

function extractShellCommand(task, hint, state) {
  // Backtick or fenced code block
  const fenced = task.match(/```(?:bash|sh|cmd|powershell)?\n?([\s\S]+?)```/);
  if (fenced) return fenced[1].trim();
  const backtick = task.match(/`([^`]+)`/);
  if (backtick) return backtick[1];

  // Common install patterns
  if (/npm install/.test(task)) return task.match(/(npm install[^\n]+)/)?.[1];
  if (/pip install/.test(task)) return task.match(/(pip install[^\n]+)/)?.[1];
  if (/git clone/.test(task))   return task.match(/(git clone[^\n]+)/)?.[1];

  return null;
}

function buildSummary(state, passLog) {
  const actions = passLog.map(p => p.action || p.type).filter(Boolean);
  const lines   = [`Completed ${passLog.length} passes: ${actions.join(" → ")}`];
  if (state.last_path) lines.push(`Output: ${state.last_path}`);
  if (state.last_url)  lines.push(`URL: ${state.last_url}`);
  if (state.last_exit_code != null) lines.push(`Exit: ${state.last_exit_code}`);
  return lines.join(" | ");
}

// ── Environment probe (same as v2) ────────────────────────────────────────────
async function probeEnvironment() {
  const which = IS_WIN ? "where" : "which";

  // Probe all shell tools in parallel — like analyze_chunk() reading data characteristics
  const [nodeVer, npmVer, pythonVer, python3Ver, pipVer, gitVer,
         curlVer, wgetVer, ffmpegVer, whisperVer, pwshVer,
         chocoVer, wingetVer, whoami, hostname, cwd] = await Promise.all([
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
    probe("pwsh --version"),
    probe("choco --version"),
    probe("winget --version"),
    probe(IS_WIN ? "whoami" : "whoami"),
    probe(IS_WIN ? "hostname" : "hostname"),
    probe(IS_WIN ? "cd" : "pwd"),
  ]);

  const pythonBin = python3Ver ? "python3" : (pythonVer ? "python" : null);
  const downloadCmd = curlVer
    ? `curl -L -o "<dest>" "<url>"`
    : (wgetVer ? `wget -O "<dest>" "<url>"` : `Invoke-WebRequest -Uri "<url>" -OutFile "<dest>"`);

  const available = {
    node:    nodeVer,
    npm:     npmVer,
    python:  python3Ver || pythonVer,
    pip:     pipVer,
    git:     gitVer,
    curl:    curlVer  ? curlVer.split("\n")[0]    : null,
    wget:    wgetVer  ? wgetVer.split("\n")[0]    : null,
    ffmpeg:  ffmpegVer? ffmpegVer.split("\n")[0]  : null,
    whisper: whisperVer,
    pwsh:    pwshVer,
    choco:   chocoVer,
    winget:  wingetVer,
  };

  const present = Object.entries(available).filter(([,v])=>!!v).map(([k,v])=>({tool:k,version:v}));
  const missing = Object.entries(available).filter(([,v])=>!v).map(([k])=>k);

  // ── Per-tool capability flags ──────────────────────────────────────────────
  // Each primitive tool gets a status so the model knows exactly what works.
  // Like fold26's CHUNK_FLAG_UNCHANGED — marks what to skip vs what to use.
  const toolCapabilities = {
    // PRIMARY
    unfold: {
      status: "✓ PRIMARY",
      use_for: "Any multi-step task. Describe in natural language. Server selects pass sequence.",
      example: `unfold({ task: "download https://example.com/file.mp3 and transcribe it" })`,
    },
    get_context: {
      status: "✓ ALWAYS FIRST",
      use_for: "Call at session start. Returns this document live with actual machine state.",
    },

    // SHELL
    shell: {
      status: "✓ available",
      use_for: "Single known shell command. cmd.exe on Windows.",
      shell_type: IS_WIN ? "cmd.exe" : "/bin/bash",
      example: IS_WIN
        ? `shell({ command: "dir C:\\\\Users\\\\Owner" })`
        : `shell({ command: "ls -la ~" })`,
      warning: "Do NOT use for binary downloads — output is text only. Use unfold or shell+curl.",
    },
    shell_stream: {
      status: "✓ available",
      use_for: "Long-running commands where you need all output (installs, builds).",
    },

    // FILESYSTEM
    fs_read:   { status: "✓ available", use_for: "Read text file content." },
    fs_write:  { status: "✓ available", use_for: "Write text to file. NOT for binary." },
    fs_list:   { status: "✓ available", use_for: "List directory." },
    fs_delete: { status: "✓ available", use_for: "Delete file or directory." },
    fs_stat:   { status: "✓ available", use_for: "File metadata." },
    fs_search: { status: "✓ available", use_for: "Recursive search by name or content regex." },

    // WEB
    web_fetch: {
      status: "✓ available — TEXT ONLY",
      use_for: "Fetch URLs that return text or JSON.",
      warning: "NEVER use for MP3, ZIP, PDF, images, or any binary. Use unfold() instead.",
      binary_alternative: `unfold({ task: "download <url> to <path>" })`,
    },

    // BROWSER
    browser_open: {
      status: ffmpegVer ? "✓ available (requires playwright chromium)" : "⚠ requires: npx playwright install chromium",
      use_for: "Launch headless Chromium. Returns session_id for subsequent browser_* calls.",
    },
    browser_navigate:   { status: "✓ available", use_for: "Navigate to URL in open session." },
    browser_click:      { status: "✓ available", use_for: "Click CSS selector." },
    browser_fill:       { status: "✓ available", use_for: "Fill form field." },
    browser_screenshot: { status: "✓ available", use_for: "Capture page as PNG." },
    browser_extract:    { status: "✓ available", use_for: "Extract text or HTML from page." },
    browser_close:      { status: "✓ available", use_for: "Close browser session." },

    // CODE
    code_exec: {
      status: pythonBin || nodeVer ? "✓ available" : "⚠ no runtimes found",
      use_for: "Run python/node/bash code snippet.",
      runtimes: [pythonBin && "python", nodeVer && "node", "bash"].filter(Boolean),
    },

    // DATABASE
    db_query:  { status: "✓ available", use_for: "SQLite SELECT. Persistent across restarts." },
    db_exec:   { status: "✓ available", use_for: "SQLite INSERT/UPDATE/DELETE/CREATE." },
    db_tables: { status: "✓ available", use_for: "List all tables." },
    db_export: { status: "✓ available", use_for: "Dump database as JSON." },

    // NOTES
    notes_write:  { status: "✓ available", use_for: "Write named markdown note. Persists to disk." },
    notes_read:   { status: "✓ available", use_for: "Read a note." },
    notes_list:   { status: "✓ available", use_for: "List all notes." },
    notes_delete: { status: "✓ available", use_for: "Delete a note." },
    notes_search: { status: "✓ available", use_for: "Search note contents." },

    // SYSTEM
    sysinfo:        { status: "✓ available", use_for: "CPU, RAM, disk, network, OS stats." },
    processes:      { status: "✓ available", use_for: "List running processes." },
    process_kill:   { status: "✓ available", use_for: "Kill process by PID." },
    clipboard_read: { status: "✓ available", use_for: "Read system clipboard." },
    clipboard_write:{ status: "✓ available", use_for: "Write system clipboard." },
    notify:         { status: "✓ available", use_for: "Desktop notification." },

    // NETWORK
    http_serve:      { status: "✓ available", use_for: "Serve a directory over HTTP." },
    http_serve_stop: { status: "✓ available", use_for: "Stop a running file server." },

    // SCHEDULE
    schedule_add:    { status: "✓ available", use_for: "Cron job. e.g. '*/5 * * * *'" },
    schedule_list:   { status: "✓ available", use_for: "List scheduled jobs." },
    schedule_remove: { status: "✓ available", use_for: "Remove a scheduled job." },

    // EMAIL
    smtp_send: {
      status: process.env.SMTP_HOST ? "✓ configured" : "⚠ needs SMTP_HOST/USER/PASS env vars",
      use_for: "Send email.",
    },

    // TELEGRAM
    tg_send: {
      status: process.env.TG_BOT_TOKEN ? "✓ token set" : "⚠ needs TG_BOT_TOKEN env var or token arg",
      use_for: "Send Telegram message to a chat_id.",
    },
    tg_listen: {
      status: process.env.TG_BOT_TOKEN ? "✓ token set" : "⚠ needs TG_BOT_TOKEN",
      use_for: "Start polling for incoming Telegram messages.",
    },
    tg_inbox:  { status: "✓ available", use_for: "Read queued Telegram messages. Clears after read." },
    tg_stop:   { status: "✓ available", use_for: "Stop Telegram bot." },

    // MEMORY
    memory_set:    { status: "✓ available", use_for: "Store in-process value. Lost on restart." },
    memory_get:    { status: "✓ available", use_for: "Retrieve in-process value." },
    memory_list:   { status: "✓ available", use_for: "List all memory keys." },
    memory_delete: { status: "✓ available", use_for: "Delete memory key." },

    // ENV / PROCESS
    env_get:      { status: "✓ available", use_for: "Read environment variable." },
    env_list:     { status: "✓ available", use_for: "List all env var names." },
    process_info: { status: "✓ available", use_for: "Server process metadata." },
  };

  // ── Pass sequence reference ────────────────────────────────────────────────
  // Tells the model exactly what the unfold engine can auto-select
  const passArchitecture = {
    description: "unfold() pipelines tasks as typed passes. Each pass receives the previous pass output via FlowState.",
    pass_types: {
      FETCH:     "Acquire data — web_fetch, binary download via curl, file read",
      SHELL:     "Shell execution — any command, git, npm, pip, system ops",
      CODE:      "Script execution — python/node/bash with optional data input",
      TRANSFORM: "Data conversion — ffmpeg audio/video, whisper transcription",
      STORE:     "Persist output — fs_write, db_exec, notes_write",
      RECALL:    "Retrieve data — fs_read, db_query, notes_read, memory_get",
      BROWSE:    "Browser automation — playwright navigate/click/extract",
      NOTIFY:    "Signal output — desktop notify, Telegram, email",
      RESPOND:   "Terminal pass — formats final result for agent (always last)",
    },
    named_strategies: {
      "Transcription River":  "FETCH → TRANSFORM(ffmpeg) → TRANSFORM(whisper) → STORE → RESPOND",
      "Download and Convert": "FETCH → TRANSFORM → STORE → RESPOND",
      "Web Harvest":          "FETCH → CODE → STORE → RESPOND",
      "Pure Fetch":           "FETCH → RESPOND",
      "Browser Quest":        "BROWSE → [STORE] → RESPOND",
      "Code and Store":       "CODE → STORE → RESPOND  (run/execute + save/write — checked before Shell Strike)",
      "Installation Stream":  "SHELL → SHELL → RESPOND",
      "Shell Strike":         "SHELL → RESPOND  (single execution, no save)",
      "Write Then Read":      "STORE → RECALL → RESPOND  (write file then read it back)",
      "Memory River":         "RECALL → [CODE] → RESPOND",
      "File Read":            "RECALL → RESPOND",
      "Notification Wave":    "[FETCH|SHELL] → NOTIFY → RESPOND",
      "Non-Action":           "RESPOND (direct answer, no tools needed)",
    },
    selection_signals: {
      has_url:       "URL detected → FETCH pass",
      has_audio:     "Audio file → TRANSFORM(ffmpeg/whisper)",
      has_transcribe:"transcri/speech/whisper → Transcription River",
      has_download:  "download/fetch/grab → FETCH with curl",
      has_browse:    "browse/navigate/scrape → BROWSE",
      has_shell:     "install/npm/pip/git → SHELL",
      has_save:      "save/write/output → STORE",
      has_recall:    "remember/recall/find → RECALL",
      has_notify:    "notify/alert/telegram → NOTIFY",
      is_multi_step: "then/after/next → multiple passes",
    },
  };

  // ── Recipes — machine-specific, generated from actual probe results ─────────
  const recipes = {
    download_binary: curlVer
      ? `shell({ command: 'curl -L -o "C:\\\\tmp\\\\file.mp3" "https://example.com/file.mp3"' })`
      : `shell({ command: 'Invoke-WebRequest -Uri "https://..." -OutFile "C:\\\\tmp\\\\file.mp3"' })`,
    download_and_transcribe: whisperVer
      ? `unfold({ task: "download https://example.com/file.mp3 and transcribe it" })`
      : `// Step 1: unfold({ task: "download https://... to C:\\\\tmp\\\\file.mp3" })\n// Step 2: shell({ command: "pip install openai-whisper" })\n// Step 3: unfold({ task: "transcribe C:\\\\tmp\\\\file.mp3" })`,
    install_whisper: pythonBin
      ? `shell({ command: "${pythonBin} -m pip install openai-whisper" })`
      : "python not found in PATH",
    install_ffmpeg: chocoVer
      ? `shell({ command: "choco install ffmpeg -y" })`
      : (wingetVer ? `shell({ command: "winget install ffmpeg" })` : "install manually from ffmpeg.org"),
    run_python: pythonBin
      ? `code_exec({ language: "python", code: "print('hello')" })`
      : "python not found — install from python.org",
    browse_page: `unfold({ task: "browse https://example.com and extract the main content" })`,
    save_to_db: `db_exec({ sql: "CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, data TEXT, ts TEXT)" })`,
    telegram_send: process.env.TG_BOT_TOKEN
      ? `tg_send({ chat_id: "YOUR_CHAT_ID", message: "Task complete" })`
      : "Set TG_BOT_TOKEN env var first",
    schedule_daily: `schedule_add({ id: "daily_task", expression: "0 9 * * *", command: "echo daily" })`,
  };

  // ── Persistence layer summary ──────────────────────────────────────────────
  const persistence = {
    memory:   { survives_restart: false, tool: "memory_set/get",  use_for: "Session working state, temp values" },
    notes:    { survives_restart: true,  tool: "notes_write/read", use_for: "Text output, transcripts, logs, markdown", path: NOTES_DIR },
    database: { survives_restart: true,  tool: "db_exec/query",    use_for: "Structured data, records, search", path: DB_FILE },
    files:    { survives_restart: true,  tool: "fs_write/read",    use_for: "Arbitrary files, scripts, exports" },
  };

  // ── Agent decision tree ────────────────────────────────────────────────────
  // Written for Qwen3's thinking mode — shapes the <think> block
  const decisionTree = [
    "1. Is this the start of a session? → call get_context() first, always.",
    "2. Does the task involve more than one step? → use unfold(). Do not chain primitives manually.",
    "3. Does it involve a URL? → check if binary (mp3/zip/pdf/exe) → unfold(), never web_fetch for binary.",
    "4. Does it involve audio/video/transcription? → unfold() → server selects Transcription River.",
    "5. Is it one known single operation I'm certain about? → use the appropriate primitive directly.",
    "6. Am I unsure which primitive to use? → use unfold() and describe the task.",
    "7. Do I need to remember something across sessions? → notes_write or db_exec, not memory_set.",
    "8. Is the task complete? → report what actually happened, including pass_results from unfold.",
  ];

  const ctx = {
    generated_at:      new Date().toISOString(),
    server_version:    "3.0.0",
    architecture:      "Wu-Wei Unfold — tasks pipeline as typed passes with shared FlowState",

    // Host facts
    host: {
      os:         process.platform,
      arch:       process.arch,
      is_windows: IS_WIN,
      node:       process.version,
      cwd:        cwd || process.cwd(),
      whoami,
      hostname,
      shell:      IS_WIN ? "cmd.exe" : "/bin/bash",
      path_entries: (process.env.PATH || process.env.Path || "").split(IS_WIN ? ";" : ":").filter(Boolean),
    },

    // What's actually installed
    tools_available: present,
    tools_missing:   missing,

    // Shell guidance derived from probe
    shell_guidance: {
      python_binary:    pythonBin,
      download_command: downloadCmd,
      use_curl:         !!curlVer,
      use_wget:         !!wgetVer && !curlVer,
      use_powershell:   !curlVer && !wgetVer,
      ffmpeg_available: !!ffmpegVer,
      whisper_available:!!whisperVer,
    },

    // Tool-by-tool capability flags — the model reads these to know what works
    tool_capabilities: toolCapabilities,

    // Pass architecture reference
    pass_architecture: passArchitecture,

    // Agent decision tree (shapes Qwen3 <think> blocks)
    agent_decision_tree: decisionTree,

    // Machine-specific recipes
    recipes,

    // Persistence options
    persistence,

    // Hard rules — always enforced
    rules: [
      "ALWAYS call get_context at session start.",
      "ALWAYS use unfold() for multi-step tasks.",
      "NEVER use web_fetch for binary files (MP3, ZIP, PDF, images). Use unfold() or shell+curl.",
      "NEVER assume a tool works — check tool_capabilities[tool].status first.",
      "NEVER use memory_set for data that must survive a restart — use notes or db.",
      "If whisper is missing and transcription is needed, install it first: pip install openai-whisper",
      "If ffmpeg is missing and audio conversion is needed, install it first.",
    ],
  };

  // Write SYSTEM_CONTEXT.json — readable by fs_read at any time
  const ctxPath = path.join(process.cwd(), "SYSTEM_CONTEXT.json");
  fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));

  // Also write a flat markdown version for easy reading
  const mdPath = path.join(process.cwd(), "SYSTEM_CONTEXT.md");
  fs.writeFileSync(mdPath, buildContextMarkdown(ctx));

  return ctx;
}

// ── Build flat markdown context (human + model readable) ──────────────────────
function buildContextMarkdown(ctx) {
  const h = ctx.host;
  const lines = [
    `# MCP Server Context — ${ctx.generated_at}`,
    ``,
    `## Host`,
    `- OS: ${h.os} (${h.arch}) | Windows: ${h.is_windows}`,
    `- Shell: ${h.shell}`,
    `- CWD: ${h.cwd}`,
    `- User: ${h.whoami} @ ${h.hostname}`,
    ``,
    `## Available Shell Tools`,
    ctx.tools_available.map(t => `- ✓ ${t.tool}: ${t.version?.split("\n")[0]}`).join("\n"),
    ``,
    `## Missing Shell Tools`,
    ctx.tools_missing.length
      ? ctx.tools_missing.map(t => `- ✗ ${t}`).join("\n")
      : "- (none missing)",
    ``,
    `## Agent Decision Tree`,
    ctx.agent_decision_tree.map(r => `- ${r}`).join("\n"),
    ``,
    `## Hard Rules`,
    ctx.rules.map(r => `- ${r}`).join("\n"),
    ``,
    `## Shell Guidance`,
    `- Python binary: ${ctx.shell_guidance.python_binary || "NOT FOUND"}`,
    `- Download command: ${ctx.shell_guidance.download_command}`,
    `- ffmpeg: ${ctx.shell_guidance.ffmpeg_available ? "✓" : "✗ not installed"}`,
    `- whisper: ${ctx.shell_guidance.whisper_available ? "✓" : "✗ not installed — pip install openai-whisper"}`,
    ``,
    `## Pass Architecture`,
    `unfold() selects from these named strategies based on task signals:`,
    Object.entries(ctx.pass_architecture.named_strategies).map(([k,v]) => `- **${k}**: ${v}`).join("\n"),
    ``,
    `## Recipes (this machine)`,
    Object.entries(ctx.recipes).map(([k,v]) => `### ${k}\n\`\`\`\n${v}\n\`\`\``).join("\n\n"),
    ``,
    `## Persistence`,
    Object.entries(ctx.persistence).map(([k,v]) =>
      `- **${k}**: ${v.tool} | persists: ${v.survives_restart} | ${v.use_for}`
    ).join("\n"),
  ];
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// MCP SERVER
// ═════════════════════════════════════════════════════════════════════════════
function createMcpServer() {
  const server = new Server(
    { name: "local-mcp", version: "3.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      let result;
      if (name === "unfold") {
        result = await unfold(args.task, { cwd: args.cwd, env: args.env, telegram_token: args.telegram_token });
      } else {
        result = await callPrimitive(name, args || {});
      }
      audit(name, args, true);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      audit(name, args, false);
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═════════════════════════════════════════════════════════════════════════════
const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if ((url.pathname==="/"||url.pathname==="/health") && req.method==="GET") {
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ name:"local-mcp", version:"3.0.0", status:"ok",
      uptime_s: Math.round(process.uptime()), sessions: sessions.size,
      tools: TOOLS.length, primary_tool: "unfold",
      architecture: "Wu-Wei pass pipeline — tasks unfold as FETCH→TRANSFORM→STORE→RESPOND sequences",
    }, null, 2)); return;
  }

  if (url.pathname==="/audit" && req.method==="GET") {
    res.writeHead(200,{"Content-Type":"application/json"});
    try {
      const lines = fs.readFileSync(LOG_FILE,"utf8").trim().split("\n").filter(Boolean);
      const limit = parseInt(url.searchParams.get("limit")||"50");
      res.end(JSON.stringify({ entries: lines.slice(-limit).map(l=>JSON.parse(l)), total: lines.length }, null, 2));
    } catch { res.end(JSON.stringify({ entries:[], total:0 })); }
    return;
  }

  if (url.pathname==="/sse" && req.method==="GET") {
    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport("/message", res);
    const sid       = transport.sessionId;
    sessions.set(sid, { transport, server: mcpServer });
    res.on("close", () => { sessions.delete(sid); console.log(`[-] ${sid}  active: ${sessions.size}`); });
    await mcpServer.connect(transport);
    console.log(`[+] ${sid}  active: ${sessions.size}`);
    return;
  }

  if (url.pathname==="/message" && req.method==="POST") {
    const sid     = url.searchParams.get("sessionId");
    const session = sessions.get(sid);
    if (!session) { res.writeHead(404); res.end(JSON.stringify({ error:"session not found" })); return; }
    await session.transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404); res.end("not found");
});

// ═════════════════════════════════════════════════════════════════════════════
// BOOT — listen immediately, everything else is background
// ═════════════════════════════════════════════════════════════════════════════

// Start listening FIRST — zero blocking before connections are accepted
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`
┌────────────────────────────────────────────────────────┐
│          LOCAL MCP SERVER  v3.0.0  Wu-Wei              │
│          無為 · Tools unfold, not accumulate           │
├────────────────────────────────────────────────────────┤
│  SSE    →  http://localhost:${PORT}/sse                   │
│  Health →  http://localhost:${PORT}/health                │
│  Audit  →  http://localhost:${PORT}/audit                 │
├────────────────────────────────────────────────────────┤
│  PRIMARY:  unfold({ task: "..." })                     │
│    ↳ analyzeTask → selectPassSequence → pipeline       │
│    ↳ FETCH → TRANSFORM → STORE → RESPOND              │
│    ↳ SHELL → RESPOND                                   │
│    ↳ BROWSE → NOTIFY → RESPOND                         │
│    ↳ RECALL → CODE → RESPOND                          │
├────────────────────────────────────────────────────────┤
│  PRIMITIVES: ${TOOLS.length - 2} direct tools available              │
│  get_context: always call first                        │
└────────────────────────────────────────────────────────┘`);
});

// SQLite + env probe both run after listen — never block connections
let _envCtx = null;
let _envProbeRunning = false;

async function getEnvCtx() {
  if (_envCtx) return _envCtx;
  if (_envProbeRunning) return {
    status: "probing",
    note: "Environment probe still running. Call get_context() again in a few seconds.",
    host: { os: process.platform, is_windows: IS_WIN, node: process.version, cwd: process.cwd() },
  };
  return null;
}

setImmediate(async () => {
  // Init SQLite in background
  try { await getDb(); } catch(e) { console.error("[boot] db error:", e.message); }

  // Probe environment in background
  _envProbeRunning = true;
  console.log("[boot] probing environment in background...");
  try {
    _envCtx = await probeEnvironment();
    const have = _envCtx.tools_available.map(t => t.tool).join(", ");
    const miss = _envCtx.tools_missing.join(", ");
    console.log(`[boot] probe complete. available: ${have}`);
    if (miss) console.log(`[boot] missing: ${miss}`);
  } catch (err) {
    console.error("[boot] probe error:", err.message);
  } finally {
    _envProbeRunning = false;
  }
});

process.on("SIGINT",  () => { console.log("\n[shutdown]"); saveDb(); process.exit(0); });
process.on("SIGTERM", () => { saveDb(); process.exit(0); });
