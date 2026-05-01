# MCP Jailbreaker (local-mcp)

A fully local MCP (Model Context Protocol) server. No cloud. No telemetry. No external APIs.  
Gives any MCP-compatible client full tool access to your machine.

## Quick start

```bash
# Install deps (one time)
npm install

# Start the server
node server.js

# Or on a custom port
MCP_PORT=4444 node server.js
```

Server starts at **http://localhost:3333**

---

## Connect your client

Point any MCP client at the SSE endpoint:

```
http://localhost:3333/sse
```

### Open WebUI / AnythingLLM / Msty
Add a new MCP connection → SSE → `http://localhost:3333/sse`

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "local-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/local-mcp/server.js"]
    }
  }
}
```

### Custom client (Node.js)
```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const client = new Client({ name: "my-client", version: "1.0.0" });
const transport = new SSEClientTransport(new URL("http://localhost:3333/sse"));
await client.connect(transport);

const tools = await client.listTools();
console.log(tools);

const result = await client.callTool({ name: "shell", arguments: { command: "uname -a" } });
console.log(result);
```

---

## Tools

| Tool | Description |
|------|-------------|
| `shell` | Execute any bash command. Returns stdout, stderr, exit_code. |
| `shell_stream` | Run a command and collect all output lines. |
| `fs_read` | Read a file → content as text. |
| `fs_write` | Write or append to a file (auto-creates dirs). |
| `fs_list` | List directory contents (optionally recursive). |
| `fs_delete` | Delete a file or directory. |
| `fs_stat` | Get file metadata: size, type, timestamps, mode. |
| `web_fetch` | Fetch any URL → status, headers, body text. |
| `memory_set` | Store a value in the server's in-memory KV store. |
| `memory_get` | Retrieve a value by key. |
| `memory_list` | List all stored keys. |
| `memory_delete` | Delete a key. |
| `env_get` | Read an environment variable. |
| `env_list` | List all env var names. |
| `process_info` | Server process info: pid, cwd, uptime, memory. |

---

## Example tool calls

```json
{ "name": "shell", "arguments": { "command": "ls -la ~" } }
{ "name": "shell", "arguments": { "command": "python3 script.py", "cwd": "/home/user/project" } }
{ "name": "fs_write", "arguments": { "path": "/tmp/note.txt", "content": "hello" } }
{ "name": "web_fetch", "arguments": { "url": "https://example.com" } }
{ "name": "memory_set", "arguments": { "key": "session_ctx", "value": { "user": "alice" } } }
```

---

## Health check

```bash
curl http://localhost:3333/health
```

Returns JSON with server status, uptime, active sessions, and tool list.

---

## Notes

- Memory is in-process only — restarting the server clears it.
- `shell` runs as whatever user started the server.
- Listens on `127.0.0.1` only — not exposed to the network by default.
- To expose on LAN: change `"127.0.0.1"` to `"0.0.0.0"` in `server.js` (last section).
