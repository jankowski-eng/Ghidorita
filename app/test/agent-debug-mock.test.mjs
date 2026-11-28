import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { debugSteps } from "../scripts/agent-autotest-debug.mjs";

// The scripted client of AUTOTEST_FLOW=agent (scripts/agent-autotest-debug.mjs) against the mock sidecar's fake target: the real WebSocketBackend and the
// real debug tools behind an in-memory MCP server. Electron (the renderer half) is not part of this.
const root = new URL("..", import.meta.url).pathname;
const r = await build({ stdin: { contents: `export { WebSocketBackend } from "./src/renderer/rpc.ts"; export { debugTools } from "./src/agent/tools/debug.ts"; export { toToolError } from "./src/agent/errors.ts";`, resolveDir: root, loader: "ts" }, bundle: true, format: "esm", write: false, platform: "node" });
const { WebSocketBackend, debugTools, toToolError } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

const proc = spawn(process.execPath, [root + "mock/server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const port = await new Promise((res) => proc.stdout.once("data", (d) => res(+String(d).trim())));
test.after(() => proc.kill());

test("the debug steps module passes against the mock's debugger through the real tools", async () => {
  const backend = new WebSocketBackend({});
  await backend.connect(port, "");
  const session = await backend.lifecycle.open("/x/prog", {}, () => {}, "blocking").result;
  const ops = backend.program(session);
  const server = new Server({ name: "t", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: debugTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const tool = debugTools.find((t) => t.name === params.name);
    const ctx = { ops, session, backend, signal: extra.signal, client: "t", mode: "full", changes: { newest: () => null }, functions: () => ops.functions.list(), tag: (p) => p };
    try { return { content: [{ type: "text", text: await tool.handler(ctx, params.arguments ?? {}) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text", text: toToolError(e).message }] }; }
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const R = await debugSteps(client);
  assert.ok(R.attach && R.step && R.continued);
  await client.close();
});
