#!/usr/bin/env node
/**
 * LOCAL MCP SERVER  v1.0.0
 * Full MCP capability over HTTP/SSE — 100% local, zero telemetry.
 * Connect any MCP client to: http://localhost:3333/sse
 *
 * Tools:  shell · shell_stream · fs_read · fs_write · fs_list
 *         fs_delete · fs_stat · web_fetch · memory_* · env_* · process_info
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);
const PORT = process.env.MCP_PORT || 3333;

// ── In-memory KV store ────────────────────────────────────────────────────────
const memory = {};

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "shell",
    description: "Execute any shell command via /bin/bash. Returns stdout, stderr, exit_code.",
    inputSchema: {
      type: "object",
      properties: {
        command:  { type: "string", description: "Shell command to execute" },
        cwd:      { type: "string", description: "Working directory (optional)" },
        timeout:  { type: "number", description: "Timeout ms (default 30000)" },
        env:      { type: "object", description: "Extra env vars to merge in" },
      },
      required: ["command"],
    },
  },
  {
    name: "shell_stream",
    description: "Run a command and collect all stdout/stderr lines. Good for long-running processes.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd:     { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "fs_read",
    description: "Read a file and return its content as text.",
    inputSchema: {
      type: "object",
      properties: {
        path:     { type: "string" },
        encoding: { type: "string", description: "Encoding (default utf8)" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_write",
    description: "Write (or append) text content to a file. Creates parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string" },
        content: { type: "string" },
        append:  { type: "boolean", description: "If true, append instead of overwrite" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "fs_list",
    description: "List a directory contents.",
    inputSchema: {
      type: "object",
      properties: {
        path:      { type: "string" },
        recursive: { type: "boolean", description: "Walk subdirectories" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_delete",
    description: "Delete a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        path:      { type: "string" },
        recursive: { type: "boolean", description: "Required to delete directories" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_stat",
    description: "Stat a path — size, type, timestamps, permissions.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch any URL. Returns status, headers, and body text.",
    inputSchema: {
      type: "object",
      properties: {
        url:     { type: "string" },
        method:  { type: "string", description: "HTTP method (default GET)" },
        headers: { type: "object" },
        body:    { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "memory_set",
    description: "Store any value in the server in-memory KV store.",
    inputSchema: {
      type: "object",
      properties: {
        key:   { type: "string" },
        value: {},
      },
      required: ["key", "value"],
    },
  },
  {
    name: "memory_get",
    description: "Retrieve a value by key from the in-memory KV store.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "memory_list",
    description: "List all keys currently stored in memory.",
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
  {
    name: "env_get",
    description: "Get the value of an environment variable.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "env_list",
    description: "List all environment variable names (keys only, not values).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "process_info",
    description: "Return info about this server process: pid, cwd, platform, uptime, memory usage.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────
async function callTool(name, args = {}) {
  switch (name) {

    case "shell": {
      const { command, cwd, timeout = 30000, env = {} } = args;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: cwd || process.cwd(),
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          shell: "/bin/bash",
          env: { ...process.env, ...env },
        });
        return { exit_code: 0, stdout, stderr };
      } catch (e) {
        return { exit_code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
      }
    }

    case "shell_stream": {
      const { command, cwd } = args;
      return new Promise((resolve) => {
        const lines = [];
        const proc = spawn("/bin/bash", ["-c", command], {
          cwd: cwd || process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout.on("data", (d) => lines.push(`[out] ${d.toString().trimEnd()}`));
        proc.stderr.on("data", (d) => lines.push(`[err] ${d.toString().trimEnd()}`));
        proc.on("close", (code) => resolve({ exit_code: code, output: lines.join("\n") }));
        proc.on("error", (e) => resolve({ exit_code: 1, output: e.message }));
      });
    }

    case "fs_read": {
      const content = fs.readFileSync(args.path, args.encoding || "utf8");
      return { path: args.path, content, bytes: Buffer.byteLength(content) };
    }

    case "fs_write": {
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      args.append
        ? fs.appendFileSync(args.path, args.content)
        : fs.writeFileSync(args.path, args.content);
      return { path: args.path, bytes: Buffer.byteLength(args.content), action: args.append ? "appended" : "written" };
    }

    case "fs_list": {
      function walk(p, recursive) {
        return fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => {
          const full = path.join(p, e.name);
          const entry = { name: e.name, path: full, type: e.isDirectory() ? "dir" : "file" };
          return recursive && e.isDirectory() ? [entry, ...walk(full, true)] : [entry];
        });
      }
      return { path: args.path, entries: walk(args.path, args.recursive || false) };
    }

    case "fs_delete":
      args.recursive
        ? fs.rmSync(args.path, { recursive: true, force: true })
        : fs.unlinkSync(args.path);
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

    case "web_fetch": {
      const { url, method = "GET", headers = {}, body } = args;
      const resp = await fetch(url, { method, headers, body: body || undefined });
      const text = await resp.text();
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      return { url, status: resp.status, ok: resp.ok, headers: respHeaders, body: text };
    }

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

    case "env_get":
      return { key: args.key, value: process.env[args.key] ?? null };

    case "env_list":
      return { keys: Object.keys(process.env).sort(), count: Object.keys(process.env).length };

    case "process_info":
      return {
        pid: process.pid,
        cwd: process.cwd(),
        uptime_s: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        memory: process.memoryUsage(),
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server factory (one per SSE session) ──────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "local-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await callTool(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
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

  // Health / info
  if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "local-mcp", version: "1.0.0", status: "ok",
      uptime_s: Math.round(process.uptime()),
      active_sessions: sessions.size,
      tools: TOOLS.map(t => t.name),
      endpoints: {
        sse:     `http://localhost:${PORT}/sse`,
        message: `http://localhost:${PORT}/message?sessionId=<id>`,
        health:  `http://localhost:${PORT}/health`,
      },
    }, null, 2));
    return;
  }

  // Open SSE session
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

  // Route message to session
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

httpServer.listen(PORT, "127.0.0.1", () => {
  const pad = " ".repeat(2);
  console.log([
    "",
    "┌─────────────────────────────────────────────────┐",
    "│         LOCAL MCP SERVER  v1.0.0                │",
    "├─────────────────────────────────────────────────┤",
    `│  SSE  →  http://localhost:${PORT}/sse               │`,
    `│  Info →  http://localhost:${PORT}/health            │`,
    "├─────────────────────────────────────────────────┤",
    "│  shell  shell_stream  fs_*  web_fetch           │",
    "│  memory_*  env_*  process_info                  │",
    "└─────────────────────────────────────────────────┘",
    "",
  ].join("\n"));
});

process.on("SIGINT",  () => { console.log("\n[shutdown]"); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));
