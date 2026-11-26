import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { WebSocketServer } from "ws";

const errors = { noProgram: -32001, cancelled: -32002, notFound: -32004, busy: -32005, stale: -32007, method: -32601, invalid: -32602, internal: -32603 };
function fail(code, message) { throw Object.assign(new Error(message), { code: errors[code] }); }
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COUNT = 1000;
const token = process.env.SIDECAR_TOKEN;
if (!token) throw new Error("SIDECAR_TOKEN is required");

function address(value) {
  const match = typeof value === "string" && /^(0x|[^:\u0000-\u001f\u007f]+::?)(0|[1-9a-f][0-9a-f]{0,15})$/.exec(value);
  if (!match) fail("invalid", "Expected a canonical hexadecimal address");
  return { space: match[1], offset: BigInt("0x" + match[2]) };
}

function readFixture(contents) {
  let document;
  try { document = JSON.parse(contents); } catch { fail("invalid", "Expected a JSON listing fixture"); }
  if (document?.format !== "ghidorita-listing-v1" || !Array.isArray(document.ranges) || !Array.isArray(document.functions)) {
    fail("invalid", "Expected a ghidorita-listing-v1 fixture with ranges and functions");
  }

  const spaces = new Map();
  const ranges = [];
  const rows = [];
  const byEntry = new Map();
  let previousRange;
  for (const range of document.ranges) {
    const start = address(range?.start);
    if (!spaces.has(start.space)) spaces.set(start.space, spaces.size);
    const rank = spaces.get(start.space);
    if (previousRange && (rank < previousRange.rank || (rank === previousRange.rank && start.offset < previousRange.end))) {
      fail("invalid", "Ranges must be ordered, contiguous within each address space’s group, and non-overlapping");
    }
    if (!Array.isArray(range.rows) || !range.rows.length) fail("invalid", "Each range needs at least one row");
    let offset = start.offset;
    for (const row of range.rows) {
      const bytes = row?.bytes;
      if (typeof bytes !== "string" || !/^[0-9a-f]{2}(?: [0-9a-f]{2}){0,15}$/.test(bytes) ||
          typeof row.mnemonic !== "string" || (row.operands !== undefined && typeof row.operands !== "string")) {
        fail("invalid", "Each row needs one to sixteen hex bytes and a mnemonic");
      }
      const length = (bytes.length + 1) / 3;
      const at = start.space + offset.toString(16);
      const prepared = { rank, offset, view: { address: at, length, bytes, mnemonic: row.mnemonic, operands: row.operands ?? "" } };
      rows.push(prepared);
      byEntry.set(at, prepared);
      offset += BigInt(length);
      if (offset > 1n << 64n) fail("invalid", "Range exceeds the address space");
    }
    ranges.push({ start: range.start, size: Number(offset - start.offset) });
    previousRange = { rank, end: offset };
  }

  const functions = [];
  const named = new Set();
  for (const fn of document.functions) {
    const row = byEntry.get(fn?.entry);
    if (!row || named.has(fn.entry) || typeof fn.name !== "string" || !fn.name ||
        !Number.isSafeInteger(fn.size) || fn.size <= 0 || typeof fn.signature !== "string") {
      fail("invalid", "Functions need a unique row entry, name, positive byte size and signature");
    }
    const range = ranges.find(({ start, size }) => {
      const at = address(start);
      return spaces.get(at.space) === row.rank && row.offset >= at.offset && row.offset + BigInt(fn.size) <= at.offset + BigInt(size);
    });
    if (!range) fail("invalid", "A function must fit in a single range");
    row.view.label = fn.name;
    named.add(fn.entry);
    functions.push({ name: fn.name, entry: fn.entry, size: fn.size, signature: fn.signature, rank: row.rank, offset: row.offset });
  }
  functions.sort((a, b) => a.rank - b.rank || (a.offset < b.offset ? -1 : 1));
  for (let index = 1; index < functions.length; index++) {
    const prev = functions[index - 1];
    const next = functions[index];
    if (prev.rank === next.rank && prev.offset + BigInt(prev.size) > next.offset) fail("invalid", "Functions must not overlap");
  }
  return { spaces, ranges, rows, functions, totalBytes: ranges.reduce((total, range) => total + range.size, 0) };
}

let active = null;
let opening = null;
async function open(params, id, notify) {
  if (opening) fail("busy", "An open is already in progress");
  if (typeof params.path !== "string" || !params.path || Object.keys(params).some((key) => key !== "path")) {
    fail("invalid", "Opening a fixture requires only its path");
  }

  const op = opening = { id, controller: new AbortController() };
  active = null;
  try {
    notify("progress", { openId: id, phase: "import", pct: 0, message: "Reading listing fixture" });
    const info = await stat(params.path);
    if (!info.isFile() || info.size > MAX_BYTES) fail("invalid", "Expected a regular fixture file up to 2 MiB");
    const bytes = await readFile(params.path, { signal: op.controller.signal });
    if (bytes.length > MAX_BYTES) fail("invalid", "Fixture file exceeds 2 MiB");
    op.controller.signal.throwIfAborted();
    const program = readFixture(bytes);
    const session = { sessionId: randomUUID(), programId: createHash("sha256").update(bytes).digest("hex"), name: basename(params.path) };
    active = { session, program };
    return { ...session, persisted: false };
  } catch (error) {
    if (op.controller.signal.aborted) fail("cancelled", "Open cancelled");
    if (error.code === "ENOENT") fail("notFound", "Fixture file not found");
    throw error;
  } finally {
    opening = null;
  }
}

function rankAddress(program, at) {
  const { space, offset } = address(at);
  if (!program.spaces.has(space)) return null;
  return { rank: program.spaces.get(space), offset };
}
function page(program, { address: at, count, direction = "forward" }) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT || !["forward", "backward"].includes(direction)) {
    fail("invalid", "Expected a page size from 0 to 1000 and a valid direction");
  }
  const target = rankAddress(program, at);
  if (!target) return [];
  const { rows } = program;
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const row = rows[mid];
    if (row.rank < target.rank || (row.rank === target.rank && row.offset < target.offset)) lo = mid + 1;
    else hi = mid;
  }
  const prev = rows[lo - 1];
  if (prev?.rank === target.rank && prev.offset + BigInt(prev.view.length) > target.offset) lo--;
  if (direction === "backward") return rows.slice(Math.max(0, lo - count), lo).map(({ view }) => view);
  return rows.slice(lo, lo + count).map(({ view }) => view);
}

const handlers = {
  provider_info: () => ({ provider: "fixture", version: 1, capabilities: [] }),
  active_session: () => active?.session ?? null,
  open_binary: open,
  cancel_open: ({ id }) => {
    if (!Number.isSafeInteger(id)) fail("invalid", "Expected an open request id");
    const cancelled = opening?.id === id && !opening.controller.signal.aborted;
    if (cancelled) opening.controller.abort();
    return { cancelled };
  },
};
const sessionHandlers = {
  close_program: () => { active = null; return {}; },
  listing_info: ({ ranges, totalBytes }) => ({ ranges, totalBytes }),
  listing_rows: page,
  list_functions: ({ functions }) => functions.map(({ name, entry, size }) => ({ name, entry, size })),
  get_function_at: (program, { address: at }) => {
    const target = rankAddress(program, at);
    if (!target) return null;
    const fn = program.functions.find(({ rank, offset, size }) => rank === target.rank && offset <= target.offset && offset + BigInt(size) > target.offset);
    return fn ? { name: fn.name, entry: fn.entry, size: fn.size, signature: fn.signature } : null;
  },
};

const server = new WebSocketServer({
  host: "127.0.0.1", port: 0, maxPayload: MAX_BYTES,
  verifyClient: ({ req }) => req.url === "/" + token,
}, () => console.log(server.address().port));
server.on("connection", (ws) => {
  if (server.clients.size > 1) { ws.close(1013, "One client at a time"); return; }
  let outstanding = 0;
  const send = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", ...message })); };
  ws.on("error", () => {});
  ws.on("close", () => opening?.controller.abort());
  ws.on("message", async (raw) => {
    let req;
    try { req = JSON.parse(raw.toString()); } catch { return; }
    if (req?.jsonrpc !== "2.0" || !Number.isSafeInteger(req.id) || typeof req.method !== "string") return;
    const { id, method, params = {}, sessionId } = req;
    if (outstanding >= 64) { send({ id, error: { code: errors.busy, message: "Too many outstanding requests" } }); return; }
    outstanding++;
    try {
      if (!params || typeof params !== "object" || Array.isArray(params)) fail("invalid", "Expected an object for params");
      let result;
      if (Object.hasOwn(handlers, method)) result = await handlers[method](params, id, (method, params) => send({ method, params }));
      else if (Object.hasOwn(sessionHandlers, method)) {
        if (typeof sessionId !== "string" || sessionId !== active?.session.sessionId) fail("stale", "Program session is no longer active");
        result = sessionHandlers[method](active.program, params);
      } else fail("method", "Unsupported method");
      send({ id, result });
    } catch (error) {
      send({ id, error: { code: Number.isInteger(error.code) ? error.code : errors.internal, message: error.message } });
    } finally { outstanding--; }
  });
});

function stop() {
  opening?.controller.abort();
  for (const ws of server.clients) ws.terminate();
  server.close(() => process.exit(0));
}
process.stdin.resume();
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
