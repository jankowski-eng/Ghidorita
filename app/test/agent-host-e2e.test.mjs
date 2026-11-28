import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The real Electron host + two real bridges + a takeover (scripts/agent-autotest-headless.mjs). Needs `npm run build` and Electron, so it is opt-in:
//   GHIDORITA_E2E=1 npm test     the takeover is a windowless stand-in running main's claim + agent server in Node
//   GHIDORITA_E2E=app npm test   the takeover is the real app (it opens a window)
const mode = process.env.GHIDORITA_E2E;
const built = fs.existsSync(new URL("../out/main/index.js", import.meta.url)) && fs.existsSync(new URL("../out/mcp/bridge.cjs", import.meta.url));
test("headless host end to end: two bridges share a host, it exits after the last one, the app takes over", { skip: !mode ? "set GHIDORITA_E2E=1 (or =app)" : !built ? "run npm run build first" : false, timeout: 400_000 }, async () => {
  const { runHeadless } = await import("../scripts/agent-autotest-headless.mjs");
  const r = await runHeadless({ standIn: mode !== "app" });
  assert.ok(r.graceExit && r.takeover);
});
