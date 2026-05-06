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

import { spawn, execSync }    from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createServer }       from 'net';
import { fileURLToPath }      from 'url';
import path                   from 'path';

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
const argv     = process.argv.slice(2);
const NO_PROXY = argv.includes('--no-proxy');
const STATUS   = argv.includes('--status');
const HELP     = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(`
  ${c.bold}launch.mjs${c.reset} — MCP-Jailbreak-0.3 · state0

  ${c.cyan}node launch.mjs${c.reset}              start everything
  ${c.cyan}node launch.mjs --no-proxy${c.reset}   skip coord-proxy (:1233)
  ${c.cyan}node launch.mjs --status${c.reset}     probe ports, no action
  ${c.cyan}node launch.mjs --help${c.reset}       this message

  Ports:  3333 server.js · 3334 server-dos.js · 1233 coord-proxy · 1234 LM Studio
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
  console.log();
}

// ── Dependency check + install ────────────────────────────────────────────────
function ensureDeps() {
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

ensureDeps();

console.log(`\n${c.bold}${c.cyan}MCP-Jailbreak-0.3 · state0${c.reset}`);
console.log(`${c.gray}Node ${process.version}  ·  ${process.platform}/${process.arch}  ·  ${new Date().toISOString()}${c.reset}\n`);

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
