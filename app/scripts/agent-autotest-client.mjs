// The scripted MCP client of AUTOTEST_FLOW=agent: a real SDK client over the real bridge (out/mcp/bridge.cjs) and the app's socket.
// Usage: GHIDORITA_AGENT_SOCKET=... node scripts/agent-autotest-client.mjs   (exit 0 = every check passed; the last stdout line is a JSON summary)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../out/mcp/bridge.cjs", import.meta.url));
const NEWNAME = "agent_counter", R = {};
const fail = (m) => { console.error("FAIL: " + m); console.log(JSON.stringify({ ok: false, error: m, ...R })); process.exit(1); };
const check = (c, m) => { if (!c) fail(m); };
const text = (r) => r.content.map((x) => x.text).join("\n");
const deadline = Date.now() + 90_000;

async function connect() {
  for (;;) {
    // --no-launch: the bridge must never start an installed Ghidorita here; until the app listens it answers "not running" itself
    const client = new Client({ name: "agent-autotest", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bridge, "--no-launch"], env: process.env, stderr: "inherit" }));
    const s = text(await client.callTool({ name: "status", arguments: {} }));
    if (/Program: \S/.test(s) && !/none open/.test(s)) return { client, s };
    await client.close();
    if (Date.now() > deadline) fail("the app never opened a program: " + s);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const { client, s: status } = await connect();
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }); return { text: text(r), error: !!r.isError }; };

check(/Access: edit \(client agent-autotest\)/.test(status), "status: " + status);
check(/server|Strings, comments/.test(client.getInstructions() ?? ""), "instructions");
const names = (await client.listTools()).tools.map((t) => t.name);
for (const n of ["status", "decompile", "rename_variable", "undo_agent_edit"]) check(names.includes(n), `tools/list lacks ${n}: ${names}`);
R.tools = names.length;

const list = await call("list_functions", { limit: 40 });
check(!list.error, list.text);
// the first function that has a local variable (a real binary starts with thunks and stubs)
const VAR = /\b([a-z]{1,3}Var\d+|local_[0-9a-f]+)\b/, PARAM = /\b(param_\d+)\b/;
let entry, old, dec;
for (const row of list.text.split("\n").filter((l) => /^0x[0-9a-f]+\s/i.test(l))) {
  const e = row.trim().split(/\s+/)[0], d = await call("decompile", { function: e });
  const m = !d.error && (d.text.match(VAR) ?? d.text.match(PARAM));
  if (m) { entry = e; old = m[1]; dec = d; break; }
}
check(old, "no function with a local variable among the first 40: " + list.text.slice(0, 400));
R.entry = entry; R.variable = old;

const ren = await call("rename_variable", { function: entry, variable: old, newName: NEWNAME });
check(!ren.error, ren.text);
const after = await call("decompile", { function: entry });
check(after.text.includes(NEWNAME) && !new RegExp(`\\b${old}\\b`).test(after.text), "the decompiler does not show the rename: " + after.text.slice(0, 400));
// The app now checks its UI and then makes an edit of the user's own; our undo must refuse to touch it
const lastEdit = async (re) => { for (;;) { const m = text(await client.callTool({ name: "status", arguments: {} })).match(/last: (.*)/); if (m && re.test(m[1])) return m[1]; if (Date.now() > deadline) fail(`status never showed ${re}`); await new Promise((r) => setTimeout(r, 300)); } };
R.userEdit = await lastEdit(/comment/i);
const refused = await call("undo_agent_edit");
check(refused.error && /user/i.test(refused.text), "undo must refuse while the user's edit is newest: " + refused.text);
await lastEdit(/Rename variable/i); // the app undid its own edit
const undo = await call("undo_agent_edit");
check(!undo.error, "undo_agent_edit: " + undo.text);
const back = await call("decompile", { function: entry });
check(back.text.includes(old) && !back.text.includes(NEWNAME), "the undo did not restore the name");
const again = await call("undo_agent_edit"); // nothing of ours is left: the guard must refuse, never reach for older history
check(again.error && /Nothing to undo|user/.test(again.text), "a second undo must be refused: " + again.text);
const off = await call("rename_variable", { function: entry, variable: "no_such_variable", newName: "x_y" });
check(off.error, "renaming a missing variable must be an error");

await client.close();
console.log(JSON.stringify({ ok: true, ...R }));
