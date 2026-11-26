// Mock sidecar: same protocol as ../../protocol.md with deterministic fake data.
import { WebSocketServer } from "ws";

const NFUNC = 5000, ROWS_PER_FUNC = 400, ROWS = NFUNC * ROWS_PER_FUNC; // 2,000,000
const BASE = 0x401000, STRIDE = 4;
const hex = (n) => "0x" + n.toString(16);
const entryOf = (i) => hex(BASE + i * ROWS_PER_FUNC * STRIDE);
const baseName = (i) => (i === 0 ? "entry" : i === 1 ? "main" : `fn_${i}`);
const STEP = ROWS_PER_FUNC * STRIDE;
// Mutable program state (all edits go through edit(), which snapshots it for undo/redo).
let S = { names: new Map(), comments: new Map(), created: new Map(), sigs: new Map(), vars: new Map(), types: new Map(), data: new Map(), labels: new Map() };
const nameOf = (i) => S.names.get(i) ?? baseName(i);
const COMMENT_KINDS = ["eol", "pre", "post", "plate", "repeatable"];
const VARS = { param_1: "int", param_2: "char *", iVar1: "int" };
const DATA_TYPES = ["bool", "byte", "char", "double", "dword", "float", "int", "long", "longlong", "pointer", "qword", "short", "string", "uint", "ulong", "undefined", "undefined4", "void", "word"]
  .map((n) => ({ name: n, path: `/${n}`, size: { bool: 1, byte: 1, char: 1, double: 8, dword: 4, float: 4, int: 4, long: 8, longlong: 8, pointer: 8, qword: 8, short: 2, uint: 4, ulong: 8, undefined: 1, undefined4: 4, word: 2 }[n] ?? -1 }));
const bad = (what) => { throw { code: -32602, message: `InvalidArgument: ${what}` }; };
const nf = () => { throw { code: -32004, message: "NotFound" }; };
const parseAddr = (a) => { if (typeof a !== "string" || !/^0x[0-9a-f]+$/i.test(a)) bad("address"); return parseInt(a, 16); };
const parseInt0 = (v, d, what) => { if (v === undefined) return d; if (!Number.isInteger(v) || v < 0) bad(what); return v; };
const idxOfEntry = (n) => { const d = n - BASE; return d >= 0 && d % STEP === 0 && d / STEP < NFUNC ? d / STEP : -1; };
const validName = (n) => { if (typeof n !== "string" || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(n)) bad("invalid name"); return n; };
const taken = (n) => {
  const m = /^fn_(\d+)$/.exec(n), j = n === "entry" ? 0 : n === "main" ? 1 : m ? +m[1] : -1;
  return (j >= 0 && j < NFUNC && nameOf(j) === n) || [...S.names.values(), ...S.created.values(), ...S.labels.values()].includes(n);
};
const v = (i, o) => S.vars.get(`${i}|${o}`) ?? o;
const ty = (i, o) => S.types.get(`${i}|${o}`) ?? VARS[o];
const decl = (t, n) => t + (t.endsWith("*") ? "" : " ") + n;
const sigOf = (i) => S.sigs.get(i) ?? `int ${nameOf(i)}(${decl(ty(i, "param_1"), v(i, "param_1"))}, ${decl(ty(i, "param_2"), v(i, "param_2"))})`;
const createdAt = (n) => { for (const [a] of S.created) if (n >= a && n < a + STRIDE * 4) return a; return -1; };
const funcAt = (n) => {
  const c = createdAt(n);
  if (c >= 0) return { name: S.created.get(c), entry: hex(c), size: STRIDE * 4, signature: `void ${S.created.get(c)}(void)` };
  const i = Math.floor((n - BASE) / STEP);
  return n >= BASE && i < NFUNC ? { name: nameOf(i), entry: entryOf(i), size: STEP, signature: sigOf(i) } : null;
};
const inv = (k) => { for (let x = 0; x < NFUNC; x++) if ((x * k) % NFUNC === 1) return x; };
const INV = { 7: inv(7), 13: inv(13), 31: inv(31) };
const refKind = (t) => (/CALL/.test(t) ? "call" : /JUMP/.test(t) ? "jump" : t === "READ" ? "read" : t === "WRITE" ? "write" : t === "DATA" ? "data" : "other");
const CALLS = [[7, 1, 3, "UNCONDITIONAL_CALL"], [13, 2, 5, "CONDITIONAL_CALL"], [31, 3, 7, "UNCONDITIONAL_CALL"]]; // [mul, add, row offset in caller, type]: callee = (caller*mul+add) % NFUNC
const calleeOf = (i, [mul, add]) => (i * mul + add) % NFUNC;
const fnRange = (i) => ({ start: entryOf(i), end: hex(BASE + (i + 1) * STEP - 1) });
const undoStack = [], redoStack = [];
let dirty = false; // set by any edit/undo/redo, reset by save
const undoState = () => ({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoName: undoStack.at(-1)?.name, redoName: redoStack.at(-1)?.name, dirty });
const decompCache = new Set();
const changed = (notify, ranges, kinds) => { dirty = true; decompCache.clear(); notify("program_changed", { ranges, kinds, undo: undoState() }); };
function edit(name, notify, ranges, kinds, fn) { // fn validates first, then mutates S; undo/redo restore whole-state snapshots
  const before = structuredClone(S);
  const result = fn() ?? {};
  undoStack.push({ name, before, after: structuredClone(S) }); redoStack.length = 0; dirty = true;
  changed(notify, ranges, kinds);
  return result;
}
const MNEMS = ["push", "mov", "lea", "call", "add", "sub", "cmp", "jne", "xor", "ret"];

const row = (idx) => {
  const h = (idx * 2654435761) >>> 0;
  const m = MNEMS[h % MNEMS.length];
  const r = { address: hex(BASE + idx * STRIDE), length: STRIDE, bytes: (h >>> 8).toString(16).padStart(8, "0").replace(/(..)/g, "$1 ").trim(),
    mnemonic: m, operands: m === "ret" ? "" : `r${h % 8}, 0x${(h % 4096).toString(16)}` };
  if (idx % ROWS_PER_FUNC === 0) r.label = nameOf(idx / ROWS_PER_FUNC);
  const dd = S.data.get(BASE + idx * STRIDE);
  if (dd) { r.mnemonic = dd.mnemonic; r.length = dd.length; r.operands = ""; }
  if (S.created.has(BASE + idx * STRIDE)) r.label = S.created.get(BASE + idx * STRIDE);
  if (S.labels.has(BASE + idx * STRIDE)) r.label = S.labels.get(BASE + idx * STRIDE);
  const ov = COMMENT_KINDS.map((k) => S.comments.get(`${BASE + idx * STRIDE}|${k}`)).find(Boolean);
  if (ov) r.comment = ov;
  else if (idx % 50 === 7 && !S.comments.has(`${BASE + idx * STRIDE}|eol`)) r.comment = `note ${idx}`;
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
  const [p1, p2, iv] = [v(i, "param_1"), v(i, "param_2"), v(i, "iVar1")];
  add([sigOf(i).replace(/;$/, "")]);
  add(["{"]);
  add([`  ${decl(ty(i, "iVar1"), iv)};`]);
  add([`  ${iv} = `, [a], `(${p1});`]);
  add([`  if (${iv} != 0) {`]);
  add([`    `, [b], `(${p2}, ${iv});`]);
  add([`  }`]);
  add([`  ${iv} = `, [c], `(${iv} + ${i});`]);
  add([`  return ${iv};`]);
  add(["}"]);
  return { text: lines.join("\n"), tokens, cached: false };
}

// Symbol table of the fake program: one function symbol per function, a label every 10th, data every 25th, 20 imports.
const symbols = () => {
  const out = [];
  for (let i = 0; i < NFUNC; i++) {
    const ns = i % 7 === 0 ? "util" : "";
    out.push({ name: nameOf(i), address: entryOf(i), kind: "function", namespace: ns, source: S.names.has(i) ? "user" : "analysis" });
    if (i % 10 === 0) out.push({ name: `loc_${i}`, address: hex(BASE + i * STEP + 8 * STRIDE), kind: "label", namespace: ns, source: "analysis" });
    if (i % 25 === 0) out.push({ name: `data_${i}`, address: hex(BASE + i * STEP + 16 * STRIDE), kind: "data", namespace: "", source: "analysis" });
  }
  for (const [a, name] of S.created) out.push({ name, address: hex(a), kind: "function", namespace: "", source: "user" });
  for (let k = 0; k < 20; k++) out.push({ name: `imp_${k}`, address: null, kind: "external", namespace: "libc.so", source: "imported" });
  return out;
};
const HUGE = 4000, SLOW = 4001; // SLOW: normal size, but times out at the default timeout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let opened = false, opening = false, openCancelled = false, openId = null;
// Project contents (fake). Seeded so the welcome pane has something to show.
const programs = new Map([
  ["a".repeat(64), { programId: "a".repeat(64), name: "demo_arm64", sourcePath: "/mock/demo_arm64", sizeBytes: 1048576, analyzed: true, lastOpened: "2026-11-01T10:00:00Z", options: {} }],
  ["b".repeat(64) + "-0123456789ab", { programId: "b".repeat(64) + "-0123456789ab", name: "firmware.bin", sourcePath: "/mock/firmware.bin", sizeBytes: 65536, analyzed: true, lastOpened: "2026-10-20T08:30:00Z", options: { loader: "Raw Binary", language: "ARM:LE:32:v8", compilerSpec: "default", baseAddress: "0x8000000" } }],
]);
const LANGS = [
  { id: "x86:LE:64:default", description: "Intel/AMD 64-bit x86", compilerSpecs: [{ id: "gcc", name: "GNU gcc" }, { id: "clang", name: "clang" }] },
  { id: "ARM:LE:32:v8", description: "ARM 32-bit little endian", compilerSpecs: [{ id: "default", name: "default" }] },
  { id: "AARCH64:LE:64:v8A", description: "Generic ARM64 v8.5-A LE", compilerSpecs: [{ id: "default", name: "default" }] },
];
const hexAddr = (a) => { if (typeof a !== "string" || !/^0x[0-9a-f]+$/i.test(a) || BigInt(a) >= 2n ** 64n) bad("baseAddress"); return "0x" + BigInt(a).toString(16); };
const optsOf = (p) => {
  const o = {};
  if (p.profile !== undefined && p.profile !== "full" && p.profile !== "fast") bad("profile");
  if (p.profile === "fast") o.profile = "fast";
  for (const k of ["loader", "language", "compilerSpec"]) if (p[k] !== undefined) { if (typeof p[k] !== "string" || !p[k]) bad(k); o[k] = p[k]; }
  if (p.language !== undefined && !LANGS.some((l) => l.id === p.language)) bad("language");
  if (p.baseAddress !== undefined) o.baseAddress = hexAddr(p.baseAddress);
  return o;
};
const idFor = (path, o) => { // not a real hash: the mock only needs distinct keys
  const base = "mock:" + path;
  return Object.keys(o).length ? base + "-" + [o.loader, o.language, o.compilerSpec, o.baseAddress, o.profile].map((x) => x ?? "").join("|") : base;
};
// like the sidecar: edits are written to the program's stored state on save, on close and when another open replaces it
const stored = new Map(); // programId -> saved S
const autosave = () => { if (opened && openId) stored.set(openId, structuredClone(S)); };
const resetProgram = () => { autosave(); S = { names: new Map(), comments: new Map(), created: new Map(), sigs: new Map(), vars: new Map(), types: new Map(), data: new Map(), labels: new Map() }; undoStack.length = 0; redoStack.length = 0; decompCache.clear(); dirty = false; };
const cancels = new Map(); // request id -> cancel fn

const handlers = {
  import_candidates({ path }) {
    if (typeof path !== "string") bad("path");
    if (opening) throw { code: -32005, message: "Busy" };
    if (/missing/.test(path)) throw { code: -32004, message: "NotFound" }; // mock: paths containing "missing"
    const sizeBytes = /big/.test(path) ? 30 * 1048576 : 4096; // mock: paths containing "big" are 30 MB (the UI defaults those to the fast profile)
    if (/\.(bin|rom|img)$/i.test(path)) return { sizeBytes, candidates: [{ loader: "Raw Binary", language: null, compilerSpec: null, preferred: true, acceptsBaseAddress: true }] };
    return { sizeBytes, candidates: [
      { loader: "Mach-O", language: "AARCH64:LE:64:v8A", compilerSpec: "default", preferred: true, acceptsBaseAddress: true },
      { loader: "Mach-O", language: "x86:LE:64:default", compilerSpec: "gcc", preferred: false, acceptsBaseAddress: true },
      { loader: "Raw Binary", language: null, compilerSpec: null, preferred: false, acceptsBaseAddress: true }] };
  },
  list_languages() { if (opening) throw { code: -32005, message: "Busy" }; return LANGS; },
  close_program() {
    if (opening) throw { code: -32005, message: "Busy" };
    for (const c of [...cancels.values()]) c(); // in-flight decompiles fail Cancelled
    resetProgram(); opened = false; openId = null;
    return {};
  },
  list_programs() {
    if (process.env.MOCK_LOCKED === "1") throw { code: -32006, message: "projects dir in use by another Ghidrette (mock)" };
    if (opening) throw { code: -32005, message: "Busy" };
    return [...programs.values()].sort((a, b) => (b.lastOpened ?? "").localeCompare(a.lastOpened ?? ""));
  },
  delete_program({ programId }) {
    if (typeof programId !== "string") bad("programId");
    if (opening || (opened && programId === openId)) throw { code: -32005, message: "Busy" };
    if (!programs.delete(programId)) nf();
    stored.delete(programId);
    return {};
  },
  async open_binary(p, notify) {
    const { path } = p;
    if (typeof path !== "string") bad("path");
    if (opening) throw { code: -32005, message: "Busy" };
    const opts = optsOf(p);
    opening = true; openCancelled = false; resetProgram(); opened = false;
    const an = (analyzer, pct, done, total) => ({ phase: "analysis", pct, message: analyzer, analyzer, done, ...(total ? { total } : {}) });
    const steps = [
      { phase: "import", pct: 0, message: `importing ${path}` }, { phase: "import", pct: 100, message: "imported" },
      an("Decompiler Parameter ID", 0, 0), an("Decompiler Parameter ID", 50, 0), an("Function Start Search", -1, 1), an("Stack", 30, 2, 8),
      an("Stack", 90, 2, 8), an("Subroutine References", -1, 3, 8), an("ASCII Strings", 100, 4, 8), an("Demangler", -1, 5),
      { phase: "saving", pct: -1, message: "saving to project" }, { phase: "ready", pct: 100, message: "ready" }];
    try {
      for (const p of steps) {
        notify("progress", p); await sleep(200);
        if (openCancelled) throw { code: -32002, message: "Cancelled" };
      }
      const programId = idFor(path, opts);
      const persisted = programs.has(programId), name = path.split("/").pop();
      programs.set(programId, { programId, name, sourcePath: path, sizeBytes: 4096, analyzed: true, lastOpened: new Date().toISOString(), options: opts });
      if (stored.has(programId)) S = structuredClone(stored.get(programId));
      opened = true; openId = programId;
      return { programId, name, persisted };
    } finally { opening = false; }
  },
  cancel_open() { const c = opening && !openCancelled; if (c) openCancelled = true; return { cancelled: c }; },
  list_functions() {
    // fn_4000 is "huge" here (size 40000, > the UI's 30 KB warning) so the size warning and "Decompile anyway" can be exercised;
    // get_function_at keeps the real STEP so address-to-function lookups stay consistent
    const out = Array.from({ length: NFUNC }, (_, i) => ({ name: nameOf(i), entry: entryOf(i), size: i === HUGE ? 40000 : STEP }));
    for (const [a, name] of S.created) out.push({ name, entry: hex(a), size: STRIDE * 4 });
    return out.sort((x, y) => parseInt(x.entry, 16) - parseInt(y.entry, 16));
  },
  decompile({ entry, timeoutSecs }, notify, rid) {
    const n = parseAddr(entry), i = idxOfEntry(n);
    if (i < 0 && !S.created.has(n)) throw { code: -32004, message: "NotFound" };
    const slowFn = i === HUGE || i === SLOW, slow = slowFn && (timeoutSecs ?? 30) < 100; // both time out unless the client asks for a long timeout
    return new Promise((resolve, reject) => {
      const done = () => {
        cancels.delete(rid);
        if (slow) return reject({ code: -32003, message: `decompile timed out after ${timeoutSecs ?? 30}s` });
        if (i < 0) return resolve({ text: `void ${S.created.get(n)}(void)\n{\n  return;\n}`, tokens: [], cached: false });
        const cached = decompCache.has(i); decompCache.add(i);
        resolve({ ...decompile(i), cached });
      };
      const t = setTimeout(done, slow ? 400 : slowFn ? 1500 : i >= 0 && decompCache.has(i) ? 5 : 150); // 1.5 s long runs leave time to click Cancel
      cancels.set(rid, () => { clearTimeout(t); cancels.delete(rid); reject({ code: -32002, message: "Cancelled" }); });
    });
  },
  listing_info: () => ({ ranges: [{ start: hex(BASE), size: ROWS * STRIDE }], totalBytes: ROWS * STRIDE }),
  async listing_rows({ address, count, direction = "forward" }) {
    await sleep(20);
    const idx = Math.floor((parseInt(address, 16) - BASE) / STRIDE);
    const [from, to] = direction === "backward" ? [idx - count, idx] : [idx, idx + count];
    const out = [];
    for (let i = Math.max(0, from); i < Math.min(ROWS, to); i++) out.push(row(i));
    return out;
  },
  // ---- reads ----
  get_function_at: ({ address }) => funcAt(parseAddr(address)),
  search_symbols({ query, limit }) {
    if (typeof query !== "string") bad("query");
    const lim = parseInt0(limit, 100, "limit"), q = query.toLowerCase(), out = [];
    for (const r of symbols()) {
      if (out.length >= lim) break;
      if (r.address && r.name.toLowerCase().includes(q)) out.push({ name: r.name, address: r.address, kind: r.kind });
    }
    return out;
  },
  xrefs_to({ address, limit }) {
    const n = parseAddr(address), lim = parseInt0(limit, 100, "limit"), i = idxOfEntry(n), out = [];
    if (i < 0) return out;
    for (const c of CALLS) { // callers: caller = (callee - add) * inverse(mul) mod NFUNC
      const j = (((i - c[1]) % NFUNC + NFUNC) * INV[c[0]]) % NFUNC;
      if (calleeOf(j, c) === i) out.push({ from: hex(BASE + j * STEP + c[2] * STRIDE), type: c[3], kind: refKind(c[3]), function: nameOf(j) });
    }
    if (i % 5 === 0) out.push({ from: hex(BASE + ((i + 1) % NFUNC) * STEP + 11 * STRIDE), type: "DATA", kind: "data", function: nameOf((i + 1) % NFUNC) }); // a pointer to every 5th function
    out.sort((x, y) => parseInt(x.from, 16) - parseInt(y.from, 16));
    return out.slice(0, lim);
  },
  xrefs_to_variable({ entry, name }) { // param_1/param_2 (as named now) have references; iVar1 is a decompiler temporary: none, like the real sidecar
    const n = parseAddr(entry), i = idxOfEntry(n);
    if (typeof name !== "string") bad("name");
    if (i < 0) nf();
    const o = ["param_1", "param_2"].find((o) => v(i, o) === name);
    if (!o) return [];
    const k = o === "param_1" ? 0 : 1;
    return [{ from: hex(BASE + i * STEP + (4 + k) * STRIDE), type: "READ", kind: "read", function: nameOf(i) }, { from: hex(BASE + i * STEP + (9 + k) * STRIDE), type: "WRITE", kind: "write", function: nameOf(i) }];
  },
  xrefs_from({ address }) {
    const n = parseAddr(address), i = Math.floor((n - BASE) / STEP);
    if (!(i >= 0 && i < NFUNC)) return [];
    const c = CALLS.find((c) => n === BASE + i * STEP + c[2] * STRIDE);
    if (c) return [{ to: entryOf(calleeOf(i, c)), type: c[3], kind: refKind(c[3]), target: "memory" }];
    if (n === BASE + i * STEP + 4 * STRIDE) return [{ to: null, type: "READ", kind: "read", target: "stack", label: "Stack[-0x10]" }];
    if (n === BASE + i * STEP + 9 * STRIDE) return [{ to: null, type: "COMPUTED_CALL", kind: "call", target: "external", label: "LIBMOCK.DLL::ext_" + i }]; // an import, like the PE case
    return [];
  },
  list_strings({ offset, limit, minLength, query }) {
    const off = parseInt0(offset, 0, "offset"), lim = parseInt0(limit, 100, "limit"), min = parseInt0(minLength, 4, "minLength");
    if (query !== undefined && typeof query !== "string") bad("query");
    const q = (query ?? "").trim().toLowerCase();
    const all = Array.from({ length: 300 }, (_, k) => { const value = `mock string #${k}${"x".repeat(k % 20)}`; return { address: hex(BASE + (k * 6000 + 11) * STRIDE), value, length: value.length + 1 }; })
      .filter((s) => s.value.length >= min && s.value.toLowerCase().includes(q));
    return { total: all.length, items: all.slice(off, off + lim) };
  },
  list_symbols({ offset, limit, query, kinds, sort, desc }) {
    const off = parseInt0(offset, 0, "offset"), lim = Math.min(1000, parseInt0(limit, 100, "limit")), srt = sort ?? "address";
    if (!["name", "address", "kind", "namespace", "source"].includes(srt)) bad("sort");
    if (query !== undefined && typeof query !== "string") bad("query");
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((k) => !["function", "label", "data", "external", "variable", "other"].includes(k)))) bad("kinds");
    const q = (query ?? "").trim().toLowerCase();
    let rows = symbols().filter((r) => (!kinds?.length || kinds.includes(r.kind)) && r.name.toLowerCase().includes(q));
    const key = { name: (r) => r.name.toLowerCase(), address: (r) => (r.address ? parseInt(r.address, 16) : -1), kind: (r) => r.kind, namespace: (r) => r.namespace, source: (r) => r.source }[srt];
    rows.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : x.name < y.name ? -1 : 1));
    if (desc) rows.reverse();
    return { total: rows.length, items: rows.slice(off, off + lim) };
  },
  // Pages of matches; a search yields to the event loop every 100k rows so cancel_search (and other requests) are served meanwhile.
  async search_memory({ pattern, kind, encoding, caseSensitive, start, limit }, _n, rid) {
    if (typeof pattern !== "string" || !pattern.trim()) bad("pattern");
    if (kind !== undefined && !["bytes", "text"].includes(kind)) bad("kind");
    if (encoding !== undefined && !["ascii", "utf16le", "utf16be"].includes(encoding)) bad("encoding");
    const lim = parseInt0(limit, 1000, "limit");
    if (lim < 1) bad("limit");
    const from = start === undefined ? 0 : parseAddr(start);
    let cancelled = false;
    cancels.set(rid, () => { cancelled = true; });
    try {
      const items = [];
      let next = null;
      if ((kind ?? "bytes") === "text") {
        const t = caseSensitive === false ? pattern.toLowerCase() : pattern;
        if ((encoding ?? "ascii") === "ascii") for (const s of handlers.list_strings({ limit: 1000, minLength: 1 }).items) {
          if (parseInt(s.address, 16) >= from && (caseSensitive === false ? s.value.toLowerCase() : s.value).includes(t)) items.push({ address: s.address, length: t.length, bytes: [...Buffer.from(s.value.slice(0, 16))].map((b) => b.toString(16).padStart(2, "0")).join(" ") });
        }
        return { items: items.slice(0, lim), next: null };
      }
      const toks = pattern.trim().split(/\s+/);
      if (toks.some((x) => !/^([0-9a-f]{2}|\?\??|\.\.?)$/i.test(x))) bad("invalid pattern: " + pattern);
      const rowBytes = (r) => (h8(r)).match(/../g).map((x) => parseInt(x, 16));
      const h8 = (r) => (((r * 2654435761) >>> 0) >>> 8).toString(16).padStart(8, "0");
      const first = Math.max(0, Math.floor((from - BASE) / STRIDE));
      for (let r = first; r < ROWS && !next; r++) {
        if (r % 100000 === 0 && r > first) { await sleep(0); if (cancelled) throw { code: -32002, message: "Cancelled" }; }
        const w = [...rowBytes(r), ...(toks.length > 4 && r + 1 < ROWS ? rowBytes(r + 1) : [])];
        for (let o = 0; o < 4 && o + toks.length <= w.length; o++) {
          if (BASE + r * STRIDE + o < from) continue;
          if (toks.every((x, k) => /^[?.]/.test(x) || parseInt(x, 16) === w[o + k])) {
            if (items.length >= lim) { next = hex(BASE + r * STRIDE + o); break; }
            items.push({ address: hex(BASE + r * STRIDE + o), length: toks.length, bytes: w.slice(o, o + Math.min(16, toks.length)).map((b) => b.toString(16).padStart(2, "0")).join(" "), function: nameOf(Math.floor(r / ROWS_PER_FUNC)) });
          }
        }
      }
      return { items, next };
    } finally { cancels.delete(rid); }
  },
  list_data_types({ query, limit }) {
    if (typeof query !== "string") bad("query");
    return DATA_TYPES.filter((d) => d.name.includes(query.toLowerCase())).slice(0, parseInt0(limit, 50, "limit"));
  },
  get_comments({ address }) {
    const n0 = parseAddr(address);
    if (n0 < BASE || n0 >= BASE + ROWS * STRIDE) nf();
    const n = BASE + Math.floor((n0 - BASE) / STRIDE) * STRIDE, idx = (n - BASE) / STRIDE, out = {};
    for (const k of COMMENT_KINDS) { const t = S.comments.get(`${n}|${k}`); if (t) out[k] = t; }
    if (idx % 50 === 7 && !S.comments.has(`${n}|eol`)) out.eol = `note ${idx}`; // the seeded EOL comments of row()
    return out;
  },
  undo_state: () => undoState(),
  // ---- edits ----
  rename_symbol({ address, newName }, notify) {
    const n = parseAddr(address), i = idxOfEntry(n);
    if (i < 0 && !S.created.has(n) && !S.labels.has(n)) nf();
    validName(newName);
    if (newName !== (i >= 0 ? nameOf(i) : S.created.get(n) ?? S.labels.get(n)) && taken(newName)) bad("duplicate name");
    return edit("Rename symbol", notify, [{ start: hex(n), end: hex(n) }], ["symbol"], () => { i >= 0 ? S.names.set(i, newName) : S.created.has(n) ? S.created.set(n, newName) : S.labels.set(n, newName); });
  },
  create_label({ address, name }, notify) {
    const n = parseAddr(address);
    validName(name);
    if (n < BASE || n >= BASE + ROWS * STRIDE) bad("address not in memory");
    if (idxOfEntry(n) >= 0 || S.created.has(n) || S.labels.has(n)) bad("a label already exists here (use rename_symbol)");
    if (taken(name)) bad("duplicate name");
    return edit("Create label", notify, [{ start: hex(n), end: hex(n) }], ["symbol"], () => { S.labels.set(n, name); });
  },
  set_comment({ address, kind, text }, notify) {
    const n = parseAddr(address);
    if (!COMMENT_KINDS.includes(kind) || typeof text !== "string" || n < BASE || n >= BASE + ROWS * STRIDE) bad("kind/text/address");
    return edit("Set comment", notify, [{ start: hex(n), end: hex(n) }], ["comment"], () => { S.comments.set(`${n}|${kind}`, text); });
  },
  create_function({ address, name }, notify) {
    const n = parseAddr(address);
    if (n < BASE || n >= BASE + ROWS * STRIDE || idxOfEntry(n) >= 0 || S.created.has(n)) bad("address");
    const nm = name === undefined ? `FUN_${n.toString(16).padStart(8, "0")}` : validName(name);
    if (taken(nm)) bad("duplicate name");
    return edit("Create function", notify, [{ start: hex(n), end: hex(n + STRIDE * 4 - 1) }], ["function"], () => { S.created.set(n, nm); return { entry: hex(n), name: nm }; });
  },
  set_function_signature({ entry, signature }, notify) {
    const i = idxOfEntry(parseAddr(entry));
    if (i < 0) nf();
    if (typeof signature !== "string" || !/^[A-Za-z_][\w\s*]*\([^()]*\)\s*;?$/.test(signature.trim())) bad("signature");
    return edit("Set function signature", notify, [fnRange(i)], ["function", "type"], () => { S.sigs.set(i, signature.trim()); });
  },
  rename_variable({ entry, name, newName, timeoutSecs }, notify) {
    parseInt0(timeoutSecs, 30, "timeoutSecs");
    const i = idxOfEntry(parseAddr(entry)), o = Object.keys(VARS).find((o) => i >= 0 && v(i, o) === name);
    if (!o) nf();
    validName(newName);
    if (Object.keys(VARS).some((x) => v(i, x) === newName && x !== o)) bad("duplicate name");
    return edit("Rename variable", notify, [fnRange(i)], ["function"], () => { S.vars.set(`${i}|${o}`, newName); });
  },
  retype_variable({ entry, name, dataType, timeoutSecs }, notify) {
    parseInt0(timeoutSecs, 30, "timeoutSecs");
    const i = idxOfEntry(parseAddr(entry)), o = Object.keys(VARS).find((o) => i >= 0 && v(i, o) === name);
    if (!o) nf();
    const d = DATA_TYPES.find((d) => d.name === dataType);
    if (!d || d.size < 0) bad("dataType");
    return edit("Retype variable", notify, [fnRange(i)], ["function"], () => { S.types.set(`${i}|${o}`, d.name); });
  },
  define_data({ address, dataType }, notify) {
    const n = parseAddr(address);
    if (typeof dataType !== "string" || n < BASE || n >= BASE + ROWS * STRIDE) bad("dataType/address");
    const arr = /^(\w+)\[(\d+)\]$/.exec(dataType.trim()), name = (arr ? arr[1] : dataType.trim()).replace(/^\//, "");
    const d = name.endsWith("*") ? { size: 8 } : DATA_TYPES.find((d) => d.name === name);
    if (!d || d.size <= 0) bad("dataType");
    const length = d.size * (arr ? +arr[2] : 1);
    return edit("Define data", notify, [{ start: hex(n), end: hex(n + length - 1) }], ["data", "code"], () => { S.data.set(n, { mnemonic: dataType, length }); });
  },
  clear_code({ address, length }, notify) {
    const n = parseAddr(address), len = parseInt0(length, STRIDE, "length");
    if (n < BASE || n >= BASE + ROWS * STRIDE || len < 1) bad("address/length");
    return edit("Clear code", notify, [{ start: hex(n), end: hex(n + len - 1) }], ["code", "data"], () => { for (let a = n; a < n + len; a += STRIDE) S.data.set(a, { mnemonic: "??", length: STRIDE }); });
  },
  save(_, notify) { // like Ghidra: history is dropped, dirty cleared
    if (!dirty) return { saved: false };
    autosave(); dirty = false; undoStack.length = 0; redoStack.length = 0;
    notify("program_changed", { ranges: [], kinds: [], undo: undoState() });
    return { saved: true };
  },
  undo(_, notify) { return step(undoStack, redoStack, "before", notify); },
  redo(_, notify) { return step(redoStack, undoStack, "after", notify); },
};
function step(from, to, side, notify) {
  const e = from.pop();
  if (!e) bad("nothing to " + (side === "before" ? "undo" : "redo"));
  S = structuredClone(e[side]); to.push(e); dirty = true;
  changed(notify, null, ["other"]);
  return undoState();
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => console.log(wss.address().port));
wss.on("connection", (ws) => {
  const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  ws.on("message", async (data) => {
    const req = JSON.parse(data.toString());
    if (req.method === "cancel_open") return ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: handlers.cancel_open() }));
    if (req.method === "cancel_decompile" || req.method === "cancel_search") { // bypasses the queue
      const c = cancels.get(req.params?.id); if (c) c();
      return ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { cancelled: !!c } }));
    }
    try {
      const h = handlers[req.method];
      if (!h) throw { code: -32601, message: "MethodNotFound" };
      if (!["open_binary", "import_candidates", "list_languages", "close_program", "list_programs", "delete_program"].includes(req.method) && (!opened || opening)) throw { code: -32001, message: "NoProgram" };
      const result = await h(req.params ?? {}, notify, req.id);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } }));
    }
  });
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
