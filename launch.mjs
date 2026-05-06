#!/usr/bin/env node
/**
 * launch.mjs — cross-platform one-click stack launcher
 *
 * Works on Windows, macOS, Linux.
 * Requires only Node.js ≥ 18 and npm.
 * Automatically runs `npm install` if node_modules is missing.
 *
 * Usage:
 *   node launch.mjs              — start everything
 *   node launch.mjs --no-proxy   — skip coord-proxy (LM Studio not running)
 *   node launch.mjs --status     — probe ports only, no action
 *   node launch.mjs --help       — show this message
 *
 * Double-click shortcuts:
 *   Windows  → start.bat
 *   macOS    → open Terminal → bash start.sh
 *   Linux    → bash start.sh
 */

import { spawn, execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createServer }       from 'net';
import { fileURLToPath }      from 'url';
import path                   from 'path';
import os                     from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Node.js version guard (must be ≥ 18 for top-level await + native fetch) ──
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  process.stderr.write(
    `[launch] Node.js >= 18 required (found v${process.versions.node}).\n` +
    `         Download: https://nodejs.org\n`
  );
  process.exit(1);
}

// ── ANSI colours (disabled when not a TTY, e.g. piped to file) ───────────────
const TTY = process.stdout.isTTY;
const c = {
  reset:   TTY ? '\x1b[0m'  : '',  bold:    TTY ? '\x1b[1m'  : '',
  dim:     TTY ? '\x1b[2m'  : '',  red:     TTY ? '\x1b[31m' : '',
  green:   TTY ? '\x1b[32m' : '',  yellow:  TTY ? '\x1b[33m' : '',
  blue:    TTY ? '\x1b[34m' : '',  magenta: TTY ? '\x1b[35m' : '',
  cyan:    TTY ? '\x1b[36m' : '',  gray:    TTY ? '\x1b[90m' : '',
};

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv      = process.argv.slice(2);
const NO_PROXY  = argv.includes('--no-proxy');
const STATUS    = argv.includes('--status');
const HELP      = argv.includes('--help') || argv.includes('-h');
const LOAD_IDX  = argv.indexOf('--load-model');
const LOAD_MODEL = LOAD_IDX >= 0 ? argv[LOAD_IDX + 1] : null;

if (HELP) {
  console.log(`
  ${c.bold}launch.mjs${c.reset} — Easy by zCHG.org

  ${c.cyan}node launch.mjs${c.reset}                         start everything
  ${c.cyan}node launch.mjs --no-proxy${c.reset}              skip coord-proxy (:1233)
  ${c.cyan}node launch.mjs --status${c.reset}                probe ports + show loaded LLMs
  ${c.cyan}node launch.mjs --load-model MODEL_ID${c.reset}   ask LM Studio to load a model
  ${c.cyan}node launch.mjs --help${c.reset}                  this message

  Ports:  3333 server.js · 3334 server-dos.js · 1233 coord-proxy · 1234 LM Studio

  Prerequisites:
    • Node.js >= 18     https://nodejs.org
    • npm               (bundled with Node)
    • LM Studio         https://lmstudio.ai  (running, with models loaded)
  `);
  process.exit(0);
}

// ── Processes ─────────────────────────────────────────────────────────────────
const STACK = [
  { label: 'MCP-A ', color: c.cyan,    script: 'server.js',      port: 3333, env: {} },
  { label: 'MCP-B ', color: c.yellow,  script: 'server-dos.js',  port: 3334, env: { MCP_PORT: '3334' } },
  { label: 'PROXY ', color: c.blue,    script: 'coord-proxy.js', port: 1233, env: {}, skip: () => NO_PROXY },
];

// ── Port probe ────────────────────────────────────────────────────────────────
// Returns true if something is already listening on the port.
function portInUse(port) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => { srv.close(); resolve(false); });
    srv.listen(port, '127.0.0.1');
  });
}

// ── Status display ────────────────────────────────────────────────────────────
async function showStatus() {
  const rows = [
    { port: 3333, label: 'server.js      (MCP primary)' },
    { port: 3334, label: 'server-dos.js  (MCP peer)   ' },
    { port: 1233, label: 'coord-proxy.js (phi-routing) ' },
    { port: 1234, label: 'LM Studio      (LLM backend) ' },
  ];
  console.log(`\n${c.bold}── Stack status ───────────────────────────────────────${c.reset}`);
  for (const { port, label } of rows) {
    const up  = await portInUse(port);
    const sym = up ? `${c.green}✓${c.reset}` : `${c.gray}✗${c.reset}`;
    console.log(`  ${sym}  :${port}  ${label}`);
  }

  // Show loaded LLMs
  const lm = await checkLmStudio();
  if (lm.up) {
    console.log(`\n${c.bold}── LM Studio :1234 — loaded models ────────────────────${c.reset}`);
    if (lm.models.length === 0) {
      console.log(`  ${c.yellow}⚠  No models loaded.${c.reset}  Open LM Studio and load at least one model.`);
    } else {
      for (const m of lm.models) console.log(`  ${c.green}●${c.reset}  ${m}`);
    }
    // Warn if expected models for the demo scripts are absent
    const EXPECTED = ['qwen3.5-9b@q3_k_xl:2', 'qwen3.5-9b@q3_k_xl'];
    const missing  = EXPECTED.filter(e => !lm.models.includes(e));
    if (missing.length) {
      console.log(`\n  ${c.yellow}⚠  Demo scripts expect:${c.reset}`);
      for (const m of missing)
        console.log(`       ${c.gray}${m}${c.reset}  — not loaded  (node launch.mjs --load-model "${m}")`);
    }
  } else {
    console.log(`\n  ${c.gray}✗  LM Studio :1234 unreachable — start it before running demos.${c.reset}`);
  }
  console.log();
}

// ── Dependency check + install ────────────────────────────────────────────────
function ensureDeps() {
  // Check npm is available
  try { execSync('npm --version', { stdio: 'ignore' }); }
  catch {
    process.stderr.write(
      `[launch] npm not found on PATH. npm is bundled with Node.js — reinstall Node.\n` +
      `         https://nodejs.org\n`
    );
    process.exit(1);
  }

  const marker = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk');
  if (!existsSync(marker)) {
    console.log(`${c.cyan}[install]${c.reset} node_modules missing — running npm install...`);
    try {
      execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
      console.log(`${c.green}[install]${c.reset} Done.\n`);
    } catch {
      console.error(`${c.red}[install]${c.reset} npm install failed. Fix errors above and retry.`);
      process.exit(1);
    }
  }
}

// ── lms CLI helpers ───────────────────────────────────────────────────────────
// lms.exe (Windows) / lms (macOS+Linux) — bundled with LM Studio in ~/.lmstudio/bin
const LMS_BIN = (() => {
  const home = os.homedir();
  const bin  = process.platform === 'win32' ? 'lms.exe' : 'lms';
  return path.join(home, '.lmstudio', 'bin', bin);
})();

function lmsRun(...args) {
  if (!existsSync(LMS_BIN)) return { ok: false, out: '' };
  try {
    const r = spawnSync(LMS_BIN, args, { encoding: 'utf8', timeout: 20000 });
    return { ok: r.status === 0, out: (r.stdout || '').trim() };
  } catch { return { ok: false, out: '' }; }
}

/** Ensure LM Studio server is running via lms server start */
async function ensureLmsServer() {
  if (!existsSync(LMS_BIN)) return; // LM Studio not installed — already warned by checkLmStudio
  const st = lmsRun('server', 'status');
  if (st.out.toLowerCase().includes('running')) return; // already up
  console.log(`${c.cyan}[LM Studio]${c.reset} Server not running — starting via lms server start ...`);
  const started = spawnSync(LMS_BIN, ['server', 'start'], { stdio: 'inherit', timeout: 20000 });
  if (started.status === 0) {
    console.log(`${c.green}[LM Studio]${c.reset} Server started on :1234`);
  } else {
    console.log(`${c.yellow}[LM Studio]${c.reset} Could not auto-start server. Start LM Studio manually or run INSTALL.bat / install.sh first.`);
  }
}

/** Load a model by key via lms load -y (non-blocking — model loads in background) */
function lmsLoadModel(key) {
  if (!existsSync(LMS_BIN)) return;
  console.log(`${c.cyan}[LM Studio]${c.reset} Loading model in background: ${key}`);
  const child = spawn(LMS_BIN, ['load', key, '-y'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref(); // don't block the launcher
}

// ── LM Studio model check ─────────────────────────────────────────────────────
// Queries GET /v1/models (OpenAI-compat endpoint) to list currently-loaded models.
// Safe: read-only, no side effects.
//
// LM Studio also supports a load API (POST /api/v0/models/load) in v0.3.x+ — we
// expose it via --load-model "model-id" but never auto-load to avoid evicting a
// running model.
async function checkLmStudio(lmPort = 1234) {
  try {
    const res = await fetch(`http://127.0.0.1:${lmPort}/v1/models`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { up: true, models: [], raw: await res.text() };
    const json = await res.json();
    const models = (json.data ?? []).map(m => m.id ?? m.model ?? String(m));
    return { up: true, models };
  } catch {
    return { up: false, models: [] };
  }
}

// Attempt to load a model via the LM Studio extended REST API (v0.3.x+).
// Returns { ok, message }.
async function loadLmModel(modelId, lmPort = 1234) {
  try {
    const res = await fetch(`http://127.0.0.1:${lmPort}/api/v0/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (res.ok) return { ok: true,  message: `Load request accepted (${res.status})` };
    return         { ok: false, message: `LM Studio returned ${res.status}: ${text.slice(0,120)}` };
  } catch (err) {
    return { ok: false, message: `Request failed: ${err.message}` };
  }
}

// ── Inline wuwei health writer (replaces the PS daemon) ──────────────────────
// Writes wuwei-routing/state/health.json every 30 s via TCP port probes.
// No separate process needed — runs inside this launcher.
function startHealthWriter() {
  const stateDir = path.join(__dirname, 'wuwei-routing', 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(__dirname, 'wuwei-routing', 'logs'), { recursive: true });

  const write = async () => {
    const check = (port) => portInUse(port).then(up => up ? 'HEALTHY' : 'DOWN');
    const [mcp, dos, llm] = await Promise.all([check(3333), check(3334), check(1234)]);
    const now = new Date().toISOString();
    const health = {
      timestamp:    now,
      cycle_id:     Math.floor(Date.now() / 1000),
      local_mcp:     { port: 3333, status: mcp, last_check: now, llm_context: 200000 },
      local_mcp_dos: { port: 3334, status: dos, last_check: now, llm_context: 199999 },
      llm:           { port: 1234, status: llm, last_check: now },
    };
    try {
      writeFileSync(path.join(stateDir, 'health.json'),     JSON.stringify(health, null, 2));
      writeFileSync(path.join(stateDir, 'active_server'),   mcp === 'HEALTHY' ? 'local-mcp' : 'local-mcp-dos');
      writeFileSync(path.join(stateDir, 'last_cycle'),      now);
    } catch { /* disk write errors are non-fatal */ }
  };

  write();
  return setInterval(write, 30_000);
}

// ── Process spawner ───────────────────────────────────────────────────────────
const children = [];

function spawnProc({ label, color, script, env }) {
  const tag = `${color}[${label}]${c.reset} `;
  const proc = spawn(process.execPath, [script], {
    cwd: __dirname,
    env: { ...process.env, ...env },
  });

  children.push(proc);

  const log = (stream, isErr) => {
    stream.on('data', chunk => {
      chunk.toString()
        .split('\n')
        .filter(l => l.trim())
        .forEach(l => {
          if (isErr) process.stderr.write(tag + c.red + l + c.reset + '\n');
          else       process.stdout.write(tag + l + '\n');
        });
    });
  };

  log(proc.stdout, false);
  log(proc.stderr, true);

  proc.on('exit', (code, sig) => {
    const reason = sig ?? `code ${code}`;
    if (code !== 0)
      process.stdout.write(`${tag}${c.red}process exited (${reason})${c.reset}\n`);
  });

  return proc;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${c.cyan}[launch]${c.reset} ${sig} — stopping stack...\n`);
  for (const ch of children) { try { ch.kill('SIGTERM'); } catch {} }
  setTimeout(() => {
    for (const ch of children) { try { ch.kill('SIGKILL'); } catch {} }
    process.exit(0);
  }, 2500).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Windows Ctrl+C sends SIGINT — covered above.
// On Windows, SIGTERM is sent by Task Manager kill; also covered.

// ── Main ──────────────────────────────────────────────────────────────────────
if (STATUS) { await showStatus(); process.exit(0); }

// --load-model: send a load request to LM Studio then exit
if (LOAD_MODEL) {
  console.log(`${c.cyan}[load-model]${c.reset} Requesting LM Studio load: ${c.bold}${LOAD_MODEL}${c.reset}`);
  console.log(`${c.gray}             (LM Studio must be running at :1234)${c.reset}`);
  const result = await loadLmModel(LOAD_MODEL);
  if (result.ok) {
    console.log(`${c.green}[load-model]${c.reset} ${result.message}`);
    console.log(`             Wait a few seconds then run ${c.cyan}node launch.mjs --status${c.reset} to verify.`);
  } else {
    console.log(`${c.yellow}[load-model]${c.reset} ${result.message}`);
    console.log(`             LM Studio v0.3.x+ is required for the load API.`);
    console.log(`             Alternatively, load the model manually in the LM Studio UI.`);
  }
  process.exit(result.ok ? 0 : 1);
}

ensureDeps();

console.log(`\n${c.bold}${c.cyan}Easy by zCHG.org${c.reset}`);
console.log(`${c.gray}Node ${process.version}  ·  ${process.platform}/${process.arch}  ·  ${new Date().toISOString()}${c.reset}\n`);

// ── LM Studio preflight ───────────────────────────────────────────────────────
// Ensures the LM Studio server is up and the model is loaded before the MCP
// stack starts, so the first llm_query call doesn't time out cold.
await ensureLmsServer();

// Check model status and trigger a background load if needed
const lmState = await checkLmStudio();
if (lmState.up) {
  if (lmState.models.length === 0) {
    // No models loaded — try to load the default model via lms
    const defaultKey = lmsRun('ls').out
      .split('\n')
      .map(l => l.trim().split(/\s+/)[0])
      .find(k => k && k.length > 3 && !k.startsWith('You') && !k.startsWith('LLM') && !k.startsWith('EMBED'));
    if (defaultKey) {
      lmsLoadModel(defaultKey);
      console.log(`${c.cyan}[LM Studio]${c.reset} Model loading in background — stack will start now, first query may be slow.`);
    } else {
      console.log(`${c.yellow}[LM Studio]${c.reset} No models on disk. Run: node install.mjs`);
    }
  }
}

await showStatus();

for (const proc of STACK) {
  if (proc.skip?.()) { console.log(`  ${c.gray}↷ :${proc.port} skipped (--no-proxy)${c.reset}`); continue; }
  const busy = await portInUse(proc.port);
  if (busy) {
    console.log(`  ${c.gray}✓ :${proc.port} already up — skipping${c.reset}`);
    continue;
  }
  console.log(`  ${proc.color}→ ${proc.script}${c.reset}`);
  spawnProc(proc);
  await new Promise(r => setTimeout(r, 700));  // stagger startup
}

startHealthWriter();

console.log(`\n${c.bold}Stack running.${c.reset}  ${c.gray}Ctrl+C to stop all.${c.reset}\n`);
