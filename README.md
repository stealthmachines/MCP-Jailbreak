<img width="656" height="601" alt="image" src="https://github.com/user-attachments/assets/c933beef-23fa-4377-89fa-d9f0c97902f3" />

# MCP Jailbreak (local-mcp)

A fully local MCP (Model Context Protocol) server. No cloud. No telemetry. No external APIs.  
Gives any MCP-compatible client full tool access to your machine.

LM Studio's initial conditions are pretty barebone.  The sandbox is so constricting!  Lets fix that...

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
While the local server-as-a-tool-suite was built for LM Studio, it can technically be used for many others platforms.

In general, add a new MCP connection → SSE → `http://localhost:3333/sse`

### LM Studio
After ensuring Developer Mode is ENABLED, you will need to add the following simple json paramters.  Navigate to Developer (left-hand side panel) → local server → click mcp.json → copy and paste the following in place of whatever was there before.

```json
{
  "mcpServers": {
    "local-mcp": {
      "url": "http://localhost:3333/sse"
    }
  }
}
```

<img width="1671" height="871" alt="image" src="https://github.com/user-attachments/assets/b70603e0-7caf-4929-afbb-a30645eb90d8" />

Then, quit out of LM Studio, open it back up, load your model.

From here, add the tool within a given chat using the "+" "attach" button...  You should now see 'local-mcp' among the toolset of your friendly bot.
<img width="1461" height="1043" alt="image" src="https://github.com/user-attachments/assets/90ea67de-89be-4afc-9db8-b64e1c2d1c32" />

From here, you may need to use a quick prompt to help your bot familiarize itself with the new tools.  I asked my bot about 'local-mcp' and it was utterly confused, but proceeded to list the tool's functions anyway, which we used to latch onto those new hands.  Silly robot.

<img width="1465" height="1001" alt="image" src="https://github.com/user-attachments/assets/94c10eaa-71b3-4bdc-8dad-b0b98a18394f" />

That's it!  You're done!  Happy trails!  Don't forget to pay me for my work after reading the license!

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
