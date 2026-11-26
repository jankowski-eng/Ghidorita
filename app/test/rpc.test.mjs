import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

class FakeWS { static OPEN = 1; readyState = 1; sent = []; send(s) { this.sent.push(s); } }
globalThis.WebSocket = FakeWS;
const r = await build({ entryPoints: [new URL("../src/renderer/rpc.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { WebSocketBackend } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

test("a call on a closed socket rejects instead of hanging", async () => {
  const b = new WebSocketBackend();
  b.ws = new FakeWS();
  b.ws.readyState = 3; // CLOSED: real send() drops the frame without throwing
  await assert.rejects(b.call("list_functions", {}), /socket closed/);
  assert.equal(b.pending.size, 0);
  assert.equal(b.ws.sent.length, 0);
});
