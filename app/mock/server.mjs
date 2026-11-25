// Mock sidecar: same protocol as ../../protocol.md with deterministic fake data.
import { WebSocketServer } from "ws";

const NFUNC = 5000, ROWS_PER_FUNC = 400, ROWS = NFUNC * ROWS_PER_FUNC; // 2,000,000
const BASE = 0x401000, STRIDE = 4;
const hex = (n) => "0x" + n.toString(16);
const entryOf = (i) => hex(BASE + i * ROWS_PER_FUNC * STRIDE);
const nameOf = (i) => (i === 0 ? "entry" : i === 1 ? "main" : `fn_${i}`);
const MNEMS = ["push", "mov", "lea", "call", "add", "sub", "cmp", "jne", "xor", "ret"];

const row = (idx) => {
  const h = (idx * 2654435761) >>> 0;
  const m = MNEMS[h % MNEMS.length];
  const r = { address: hex(BASE + idx * STRIDE), bytes: (h >>> 8).toString(16).padStart(8, "0").replace(/(..)/g, "$1 ").trim(),
    mnemonic: m, operands: m === "ret" ? "" : `r${h % 8}, 0x${(h % 4096).toString(16)}` };
  if (idx % ROWS_PER_FUNC === 0) r.label = nameOf(idx / ROWS_PER_FUNC);
  if (idx % 50 === 7) r.comment = `note ${idx}`;
  return r;
};

function decompile(i) {
  const a = (i * 7 + 1) % NFUNC, b = (i * 13 + 2) % NFUNC, c = (i * 31 + 3) % NFUNC;
  const tokens = [];
  const lines = [];
  const add = (parts) => { // parts: string | [string, targetIdx]
    let s = "";
    for (const p of parts) {
      if (typeof p === "string") s += p;
      else { tokens.push({ line: lines.length, colStart: s.length, colEnd: s.length + nameOf(p[0]).length, kind: "function", targetFunction: entryOf(p[0]) }); s += nameOf(p[0]); }
    }
    lines.push(s);
  };
  add([`int ${nameOf(i)}(int param_1, char *param_2)`]);
  add(["{"]);
  add(["  int iVar1;"]);
  add([`  iVar1 = `, [a], `(param_1);`]);
  add([`  if (iVar1 != 0) {`]);
  add([`    `, [b], `(param_2, iVar1);`]);
  add([`  }`]);
  add([`  iVar1 = `, [c], `(iVar1 + ${i});`]);
  add([`  return iVar1;`]);
  add(["}"]);
  return { text: lines.join("\n"), tokens, cached: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let opened = false;
let cancelDecompile = null;

const handlers = {
  async open_binary({ path }, notify) {
    const steps = [["import", 0, `importing ${path}`], ["import", 100, "imported"], ["analysis", -1, "analyzing"], ["analysis", -1, "analyzing (2)"], ["index", 50, "indexing"], ["index", 100, "indexed"], ["ready", 100, "ready"]];
    for (const [phase, pct, message] of steps) { notify("progress", { phase, pct, message }); await sleep(300); }
    opened = true;
    return { programId: "mock", name: path.split("/").pop() };
  },
  list_functions() {
    return Array.from({ length: NFUNC }, (_, i) => ({ name: nameOf(i), entry: entryOf(i), size: ROWS_PER_FUNC * STRIDE }));
  },
  decompile({ entry }) {
    const i = Math.round((parseInt(entry, 16) - BASE) / (ROWS_PER_FUNC * STRIDE));
    if (!(i >= 0 && i < NFUNC)) throw { code: -32004, message: "NotFound" };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cancelDecompile = null; resolve(decompile(i)); }, 150);
      cancelDecompile = () => { clearTimeout(t); cancelDecompile = null; reject({ code: -32002, message: "Cancelled" }); };
    });
  },
  listing_info: () => ({ rowCount: ROWS }),
  async listing_rows({ startIndex, count }) {
    await sleep(20);
    const end = Math.min(ROWS, startIndex + count);
    const out = [];
    for (let i = Math.max(0, startIndex); i < end; i++) out.push(row(i));
    return out;
  },
  address_to_row({ address }) {
    const idx = Math.floor((parseInt(address, 16) - BASE) / STRIDE);
    if (!(idx >= 0 && idx < ROWS)) throw { code: -32004, message: "NotFound" };
    return { index: idx };
  },
  row_to_address({ index }) {
    if (!(index >= 0 && index < ROWS)) throw { code: -32004, message: "NotFound" };
    return { address: hex(BASE + index * STRIDE) };
  },
};

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => console.log(wss.address().port));
wss.on("connection", (ws) => {
  const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  ws.on("message", async (data) => {
    const req = JSON.parse(data.toString());
    if (req.method === "cancel_decompile") { // bypasses the queue
      const c = cancelDecompile; if (c) c();
      return ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { cancelled: !!c } }));
    }
    try {
      const h = handlers[req.method];
      if (!h) throw { code: -32601, message: "MethodNotFound" };
      if (req.method !== "open_binary" && !opened && req.method !== "cancel_decompile") throw { code: -32001, message: "NoProgram" };
      const result = await h(req.params ?? {}, notify);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } }));
    }
  });
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
