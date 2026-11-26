// Mock sidecar: same protocol as ../../protocol.md with deterministic fake data.
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const NFUNC = 5000, ROWS_PER_FUNC = 400, ROWS = NFUNC * ROWS_PER_FUNC; // 2,000,000
const BASE = 0x401000, STRIDE = 4;
const GLOBAL = "0x601040"; // the global g_state of every decompiled function: xrefs_to it returns a few data references
const hex = (n) => "0x" + n.toString(16);
const entryOf = (i) => hex(BASE + i * ROWS_PER_FUNC * STRIDE);
const baseName = (i) => (i === 0 ? "entry" : i === 1 ? "main" : `fn_${i}`);
const STEP = ROWS_PER_FUNC * STRIDE;
// Mutable program state (all edits go through edit(), which snapshots it for undo/redo).
const freshS = () => ({ names: new Map(), comments: new Map(), created: new Map(), sigs: new Map(), vars: new Map(), types: new Map(), data: new Map(), labels: new Map(), dt: new Map(), cats: new Set(), bookmarks: new Map() });
let S = freshS();
const nameOf = (i) => S.names.get(i) ?? baseName(i);
const COMMENT_KINDS = ["eol", "pre", "post", "plate", "repeatable"];
const VARS = { param_1: "int", param_2: "char *", iVar1: "int" };
const DATA_TYPES = ["bool", "byte", "char", "double", "dword", "float", "int", "long", "longlong", "pointer", "qword", "short", "string", "uint", "ulong", "undefined", "undefined4", "void", "word"]
  .map((n) => ({ name: n, path: `/${n}`, size: { bool: 1, byte: 1, char: 1, double: 8, dword: 4, float: 4, int: 4, long: 8, longlong: 8, pointer: 8, qword: 8, short: 2, uint: 4, ulong: 8, undefined: 1, undefined4: 4, word: 2 }[n] ?? -1 }));
const bad = (what) => { throw { code: -32602, message: `InvalidArgument: ${what}` }; };
const nf = () => { throw { code: -32004, message: "NotFound" }; };
// qualified ("OVL1::1000") and beyond-2^53 addresses are valid but name nothing the number-based mock edits: -1
const parseAddr = (a) => { if (typeof a !== "string" || !/^(0x[0-9a-f]+|[^:\s]+::?[0-9a-f]+)$/i.test(a)) bad("address"); return /^0x/i.test(a) && BigInt(a) < 2n ** 53n ? parseInt(a, 16) : -1; };
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
const busyAnalysis = () => { if (an.state === "running") throw { code: -32005, message: "Busy: analysis running" }; };
function edit(name, notify, ranges, kinds, fn) { // fn validates first, then mutates S; undo/redo restore whole-state snapshots
  busyAnalysis(); // like the sidecar: Ghidra's analysis is one open transaction, an edit would join it (protocol.md, Analysis)
  const before = structuredClone(S);
  let result;
  try { result = fn() ?? {}; } catch (e) { S = before; throw e; } // like a rolled-back Ghidra transaction
  undoStack.push({ name, before, after: structuredClone(S) }); redoStack.length = 0; dirty = true;
  changed(notify, ranges, kinds);
  return result;
}
const MNEMS = ["push", "mov", "lea", "call", "add", "sub", "cmp", "jne", "xor", "ret"];

const hexb = (h, n) => Array.from({ length: n }, (_, k) => (((h >>> ((k % 4) * 8)) + k) & 255).toString(16).padStart(2, "0")).join(" ");
const partsOf = (dd) => { // components of applied struct/array data, like the sidecar's `parts`
  const t = S.dt.get(dd.ref.path);
  if (!t) return {};
  const all = dd.ref.count > 1 ? Array.from({ length: dd.ref.count }, (_, k) => ({ offset: k * sizeOf(t), length: sizeOf(t), type: t.name, name: `[${k}]`, value: "0x0" }))
    : t.kind === "struct" ? t.comps.reduce((a, c, k) => (a.list.push({ offset: a.off, length: c.len, type: c.display ?? "undefined", name: c.name ?? `field${k}`, value: "0x0" }), a.off += c.len, a), { list: [], off: 0 }).list : [];
  return all.length ? { parts: all.slice(0, 64), ...(all.length > 64 ? { partsTotal: all.length } : {}) } : {};
};
const callersOf = (n) => { const i = idxOfEntry(n); return i < 0 ? [] : handlers.xrefs_to({ address: hex(n), limit: 1000 }); };
const row = (idx) => {
  const h = (idx * 2654435761) >>> 0;
  const m = MNEMS[h % MNEMS.length];
  const a = BASE + idx * STRIDE;
  const r = { address: hex(a), length: STRIDE, bytes: (h >>> 8).toString(16).padStart(8, "0").replace(/(..)/g, "$1 ").trim(), mnemonic: m, operands: m === "ret" ? "" : `r${h % 8}, 0x${(h % 4096).toString(16)}` };
  if (idx % ROWS_PER_FUNC === 0) {
    const i = idx / ROWS_PER_FUNC;
    r.label = nameOf(i);
    if (i % 5 === 0) { r.labels = [r.label, `alias_${i}`]; }
    r.header = { signature: sigOf(i), convention: "__cdecl", params: 2, paramBytes: 16, localBytes: 32 };
  }
  const dd = S.data.get(a);
  const live = dd && (!dd.ref || S.dt.get(dd.ref.path)); // applied data of a deleted type disappears
  if (live) {
    r.mnemonic = dd.mnemonic; r.length = dd.ref ? sizeOf(S.dt.get(dd.ref.path)) * dd.ref.count : dd.length; r.operands = "";
    if (r.length > 16) { r.bytes = hexb(h, 16); r.bytesMore = r.length - 16; }
    if (dd.ref) Object.assign(r, partsOf(dd));
  }
  for (const b of S.bookmarks.values()) if (b.n === a) (r.bookmarks ??= []).push({ category: b.category, comment: b.comment });
  if (S.created.has(a)) { r.label = S.created.get(a); r.header = { signature: `void ${r.label}(void)`, params: 0, paramBytes: 0, localBytes: 0 }; }
  if (S.labels.has(a)) r.label = S.labels.get(a);
  for (const [k, f] of [["eol", "comment"], ["pre", "pre"], ["post", "post"], ["plate", "plate"], ["repeatable", "repeatable"]]) { const t = S.comments.get(`${a}|${k}`); if (t) r[f] = t; }
  if (idx % 50 === 7 && !S.comments.has(`${a}|eol`)) r.comment = `note ${idx}`;
  if (idx % ROWS_PER_FUNC === 0 || S.created.has(a)) { const x = callersOf(a); if (x.length) r.xrefs = { count: x.length, items: x.slice(0, 5).map((q) => ({ from: q.from, kind: q.kind })) }; }
  return r;
};
// Extra segments after the main one: a range above 2^63 in the default space and an overlay space (read-only, plain instruction rows).
const SEGS = [
  { space: "", base: BigInt(BASE), n: ROWS, mk: row },
  { space: "", base: 0xfffffffffff00000n, n: 64 },
  { space: "OVL1::", base: 0x1000n, n: 64 },
];
const segAddr = (g, i) => (g.space ? g.space + (g.base + BigInt(i * STRIDE)).toString(16) : "0x" + (g.base + BigInt(i * STRIDE)).toString(16));
SEGS.forEach((g) => { g.row = g.mk ?? ((i) => ({ address: segAddr(g, i), length: STRIDE, bytes: hexb(i * 77 + 1, 4), mnemonic: i === 0 ? "nop" : "mov", operands: i === 0 ? "" : `r0, 0x${i.toString(16)}`, ...(i === 0 ? { label: `${g.space || "high"}_start`, plate: `segment ${g.space || "high"}` } : {}) })); });
const segOf = (address) => { // -> [segment, row index within it] for an address string, or null
  const m = /^(?:(0x)|(.*?::?))([0-9a-f]+)$/i.exec(address);
  if (!m) bad("address");
  const sp = m[1] ? "" : m[2].replace(/(?<!:):$/, "::"), off = BigInt("0x" + m[3]);
  const g = SEGS.find((g) => g.space === sp && off >= g.base && off < g.base + BigInt(g.n * STRIDE));
  return g ? [g, Number((off - g.base) / BigInt(STRIDE))] : null;
};
const gIndex = (address) => { // global row index of the row at/after `address` (a gap maps to the next segment's first row)
  const f = segOf(address);
  if (f) return SEGS.slice(0, SEGS.indexOf(f[0])).reduce((a, g) => a + g.n, 0) + f[1];
  const m = /^(?:(0x)|(.*?::?))([0-9a-f]+)$/i.exec(address);
  return m && m[1] && BigInt(address) >= SEGS[0].base + BigInt(ROWS * STRIDE) && BigInt(address) < SEGS[1].base ? ROWS : m && m[1] && BigInt(address) < SEGS[0].base ? 0 : SEGS.reduce((a, g) => a + g.n, 0);
};
const rowAtG = (gi) => { for (const g of SEGS) { if (gi < g.n) return g.row(gi); gi -= g.n; } return null; };

function decompile(i) {
  const a = (i * 7 + 1) % NFUNC, b = (i * 13 + 2) % NFUNC, c = (i * 31 + 3) % NFUNC;
  const tokens = [];
  const lines = [];
  const add = (parts) => { // parts: string | [functionIdx] (call target) | {v: name, kind, at: instruction row, g?: true} (variable token)
    let s = "";
    for (const p of parts) {
      if (typeof p === "string") s += p;
      else if (Array.isArray(p)) { tokens.push({ line: lines.length, colStart: s.length, colEnd: s.length + nameOf(p[0]).length, kind: "function", targetFunction: entryOf(p[0]) }); s += nameOf(p[0]); }
      else { tokens.push({ line: lines.length, colStart: s.length, colEnd: s.length + p.v.length, kind: p.kind, varName: p.v, address: hex(BASE + i * STEP + p.at * STRIDE), ...(p.g ? { varAddress: GLOBAL } : {}) }); s += p.v; }
    }
    lines.push(s);
  };
  const [p1, p2, iv] = [v(i, "param_1"), v(i, "param_2"), v(i, "iVar1")];
  const P1 = { v: p1, kind: "param", at: 4 }, P2 = { v: p2, kind: "param", at: 6 }, V = (at) => ({ v: iv, kind: "variable", at });
  add([sigOf(i).replace(/;$/, "")]);
  add(["{"]);
  add([`  ${decl(ty(i, "iVar1"), iv)};`]);
  add([`  `, V(4), ` = `, [a], `(`, P1, `);`]);
  add([`  if (`, V(5), ` != 0) {`]);
  add([`    `, [b], `(`, P2, `, `, V(6), `);`]);
  add([`  }`]);
  add([`  `, V(7), ` = `, [c], `(`, V(7), ` + ${i});`]);
  add([`  `, { v: "g_state", kind: "variable", at: 8, g: true }, ` = `, V(8), `;`]);
  add([`  return `, V(8), `;`]);
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
// ---- data types (see protocol.md "Data types"; layout rules are a simplified copy of Ghidra's) ----
const fill = (n) => Array.from({ length: n }, () => ({ undef: true, len: 1 }));
const sizeOf = (t) => t.kind === "struct" ? t.comps.reduce((a, c) => a + c.len, 0) : t.kind === "union" ? Math.max(0, ...t.comps.map((c) => c.len)) : t.size;
const nodeOf = (t) => ({ name: t.name, path: t.path, kind: t.kind, size: sizeOf(t) });
const resolveType = (text, allowDynamic = false) => {
  if (typeof text !== "string" || !text.trim()) bad("type");
  const t = text.trim();
  let m = /^(.+?)\s*\*$/.exec(t);
  if (m) { const b = resolveType(m[1], true); return { display: b.display + " *", path: `/${b.display} *`, size: 8, kind: "pointer" }; }
  m = /^(.+)\[(\d+)\]$/.exec(t);
  if (m) { const b = resolveType(m[1]); return { display: `${b.display}[${m[2]}]`, path: `/${b.display}[${m[2]}]`, size: b.size * +m[2], kind: "array" }; }
  const name = t.replace(/^\//, ""), u = S.dt.get("/" + name) ?? S.dt.get(t) ?? [...S.dt.values()].find((x) => x.name === name);
  if (u) return { display: u.name, path: u.path, size: sizeOf(u), kind: u.kind };
  const d = DATA_TYPES.find((d) => d.name === name);
  if (!d || (!allowDynamic && d.size <= 0)) bad("unknown or dynamic data type");
  return { display: d.name, path: d.path, size: d.size, kind: "builtin" };
};
const getDt = (path) => { const t = S.dt.get(path); if (!t) nf(); return t; };
const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const catSet = () => { const out = new Set(["/"]); for (const c of S.cats) for (let p = c; p !== "/"; p = parentOf(p)) out.add(p); return out; };
const offsets = (comps) => { let o = 0; return comps.map((c) => { const r = o; o += c.len; return r; }); };
const detail = (t) => {
  const d = { ...nodeOf(t), source: "program", writable: true, description: "", archive: null };
  if (t.kind === "struct" || t.kind === "union") {
    Object.assign(d, { packed: !!t.packed, packingValue: t.packingValue ?? null, minAlign: null, alignment: t.packed ? 4 : 1 });
    const off = t.kind === "struct" ? offsets(t.comps) : t.comps.map(() => 0);
    d.components = t.comps.map((c, i) => ({ ordinal: i, offset: off[i], length: c.len, type: c.undef ? "undefined" : c.display, typePath: c.undef ? "/undefined" : c.typePath, name: c.name ?? null,
      defaultName: `field${i}_0x${off[i].toString(16)}`, comment: c.comment ?? null, undefined: !!c.undef, bitfield: false }));
  } else if (t.kind === "enum") d.values = [...t.values].sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : a.name.localeCompare(b.name)));
  else if (t.kind === "typedef" || t.kind === "pointer") Object.assign(d, { base: t.base, basePath: t.basePath ?? null });
  return d;
};
const reqName = (n) => { if (typeof n !== "string" || !/^[^\s/]+$/.test(n)) bad("name"); return n; };
const catOf = (c) => { if (typeof c !== "string" || !c.startsWith("/")) bad("category"); return c.length > 1 ? c.replace(/\/$/, "") : "/"; };
const join = (cat, name) => (cat === "/" ? "" : cat) + "/" + name;
const addType = (t) => { if (S.dt.has(t.path)) bad(`${t.name} already exists`); S.dt.set(t.path, t); return t; };
const ord = (op, hi) => { if (!Number.isInteger(op.ordinal) || op.ordinal < 0 || op.ordinal >= hi) bad("ordinal"); return op.ordinal; };
const optStr = (v) => { if (v !== undefined && typeof v !== "string") bad("string"); return v || undefined; };
const mkComp = (op, t) => { const r = resolveType(op.type); if (r.path === t.path) bad("cycle"); return { len: r.size, display: r.display, typePath: r.path, name: optStr(op.name), comment: optStr(op.comment) }; };
const startOf = (comps, i) => offsets(comps)[i];
const parseEnumValue = (v) => { let b; try { b = typeof v === "string" ? BigInt(v) : BigInt(v); } catch { bad("value"); } if (b < -(2n ** 63n) || b >= 2n ** 64n) bad("value"); return b.toString(); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let opened = false, opening = false, openCancelled = false, openId = null;
let activeSession = null, openingRequest = null;
let failedAutosave = false, failedListing = false;
const providerInfo = { provider: "mock", version: 1, capabilities: ["importOptions", "decompile", "editing",
  "variableEditing", "undo", "save", "symbolSearch", "symbolTable", "strings", "memorySearch",
  "references", "variableReferences", "dataTypes", "typeEditing", "projects", "coverage", "controlFlowGraph", "callGraph", "suggestions", "export", "exportGzf", "bytes", "calls", "bookmarks", "analysis", "debugger", "decompilerEdits", "stackFrame", "undefinedRefs"] };
// Project contents (fake). Seeded so the welcome pane has something to show.
const programs = new Map([
  ["a".repeat(64), { programId: "a".repeat(64), name: "demo_arm64", sourcePath: "/mock/demo_arm64", sizeBytes: 1048576, analyzed: true, analysis: "done", analysisProfile: "full", lastOpened: "2026-11-01T10:00:00Z", options: {} }],
  ["b".repeat(64) + "-0123456789ab", { programId: "b".repeat(64) + "-0123456789ab", name: "firmware.bin", sourcePath: "/mock/firmware.bin", sizeBytes: 65536, analyzed: true, analysis: "done", analysisProfile: "full", lastOpened: "2026-10-20T08:30:00Z", options: { loader: "Raw Binary", language: "ARM:LE:32:v8", compilerSpec: "default", baseAddress: "0x8000000" } }],
]);
programs.set("c".repeat(64), { programId: "c".repeat(64), name: "big_partial", sourcePath: "/mock/big_partial", sizeBytes: 30 * 1048576, analyzed: false, analysis: "partial", analysisProfile: "full", funcs: 1500, lastOpened: "2026-10-01T10:00:00Z", options: {} });
programs.set("d".repeat(64) + "-fedcba987654", { programId: "d".repeat(64) + "-fedcba987654", name: "big_fast", sourcePath: "/mock/big_fast", sizeBytes: 30 * 1048576, analyzed: true, analysis: "done", analysisProfile: "fast", lastOpened: "2026-09-01T10:00:00Z", options: { profile: "fast" } });
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
const resetProgram = () => { dbgReset(); anCancel(); autosave(); anReset(); S = freshS(); undoStack.length = 0; redoStack.length = 0; decompCache.clear(); dirty = false; };
// ---- debugger (mock): a fake stopped target. It stops in main (index 1) at +0x10, one step is 4 bytes within the function, continue runs to the next breakpoint
// (or until pause); the registers follow the stop count so that some change at every stop ----
let dbg = { state: "detached", target: "", stop: 0, bps: [], pc: 0, error: "" }, dbgTimer = null, dbgNotify = null;
const dbgReset = () => { clearTimeout(dbgTimer); dbg = { state: "detached", target: "", stop: 0, bps: [], pc: 0, error: "" }; };
const dbgRegs = () => Object.entries({ r0: dbg.stop * 3, r1: 0x20000000, r2: dbg.pc & 0xff, r3: 0, r4: dbg.stop % 2, sp: 0x20010000 - dbg.stop * 4, lr: BASE + 0x2d, pc: dbg.pc, xpsr: 0x01000000 })
  .map(([name, v]) => ({ name, value: "0x" + (v >>> 0).toString(16).padStart(8, "0") }));
const dbgPublish = () => dbgNotify?.("debug_state", { state: dbg.state, target: dbg.target, stop: dbg.stop, offset: "0x0", breakpoints: dbg.bps.map(hex),
  ...(dbg.state === "stopped" ? { address: hex(dbg.pc), registers: dbgRegs() } : {}), ...(dbg.error ? { error: dbg.error } : {}) });
const dbgStopAt = (pc) => { dbg.state = "stopped"; dbg.pc = pc; dbg.stop++; dbgPublish(); };
const dbgNeed = (state) => { if (dbg.state === "detached") throw { code: -32008, message: "Not attached to a target" }; if (dbg.state !== state) throw { code: -32005, message: state === "stopped" ? "The target is running" : "The target is not running" }; };
// ---- background analysis (mock): functions appear over MOCK_ANALYSIS_MS, the list grows, edits are Busy meanwhile ----
const ANALYSIS_MS = +(process.env.MOCK_ANALYSIS_MS ?? 4000), TICKS = 20, ANALYZERS = ["Decompiler Parameter ID", "Function Start Search", "Stack", "Subroutine References", "ASCII Strings", "Demangler"];
let an = { state: "idle", analysis: "none", profile: "full", analyzer: "", done: 0, pct: -1 }; // the AnalysisState of protocol.ts
let anTimer = null, anFuncs = NFUNC, anTick = 0, anNotify = null;
const anPublish = () => anNotify?.("analysis_state", { ...an });
const anRecord = () => { const e = programs.get(openId); if (e) { e.analysis = an.analysis; e.analysisProfile = an.profile; e.analyzed = an.analysis === "done"; e.funcs = anFuncs; } };
function anEnd(state, analysis) {
  clearInterval(anTimer); anTimer = null;
  an = { ...an, state, analysis, analyzer: "", pct: state === "done" ? 100 : -1 };
  if (analysis === "done") anFuncs = NFUNC;
  anRecord(); anPublish();
  anNotify?.("program_changed", { ranges: null, kinds: ["symbol", "function", "code", "data", "comment", "type", "other"], undo: undoState() }); // like the sidecar: one last refresh after the end
}
function anStart(notify, profile) {
  anNotify = notify; const upgrade = an.analysis === "done"; // fast -> full: the functions are all there already
  if (process.env.MOCK_ANALYSIS_START_FAIL === "1") { an = { ...an, state: "failed", analyzer: "", pct: -1, error: "analysis did not start: mock" }; anPublish(); return; } // like the sidecar: the program stays open and editable, Resume retries
  an = { state: "running", analysis: "partial", profile, analyzer: ANALYZERS[0], done: 0, pct: 0 };
  anTick = upgrade ? 0 : Math.floor(TICKS * anFuncs / NFUNC); anRecord(); anPublish();
  anTimer = setInterval(() => {
    anTick++;
    if (!upgrade) anFuncs = Math.min(NFUNC, Math.floor(NFUNC * anTick / TICKS));
    if (anTick >= TICKS) return anEnd("done", "done");
    an = { ...an, analyzer: ANALYZERS[anTick % ANALYZERS.length], done: anTick, pct: (anTick * 100 / TICKS) | 0 };
    anPublish();
    if (!upgrade) { decompCache.clear(); notify("program_changed", { ranges: null, kinds: ["symbol", "function", "code", "data", "comment", "type", "other"], undo: undoState() }); }
  }, ANALYSIS_MS / TICKS);
}
const anCancel = () => { if (an.state !== "running") return false; anEnd("cancelled", "partial"); return true; };
const anReset = () => { clearInterval(anTimer); anTimer = null; an = { state: "idle", analysis: "none", profile: "full", analyzer: "", done: 0, pct: -1 }; anFuncs = NFUNC; };
const cancels = new Map(); // request id -> cancel fn

const handlers = {
  provider_info: () => providerInfo,
  active_session: () => activeSession,
  import_candidates({ path }) {
    if (typeof path !== "string") bad("path");
    if (opening) throw { code: -32005, message: "Busy" };
    if (/missing/.test(path)) throw { code: -32004, message: "NotFound" }; // mock: paths containing "missing"
    const sizeBytes = /big/.test(path) ? 30 * 1048576 : 4096; // mock: paths containing "big" are 30 MB (the UI defaults those to the fast profile)
    const entropy = Array.from({ length: 24 }, (_, i) => (i < 6 ? 5.8 : i < 18 ? 6.4 : 7.9)); // mock: some code, data, then a packed tail
    const profiles = [{ id: "full", label: "Full" }, { id: "fast", label: "Fast (skips switch analysis, call-convention ID, stack)" }];
    const defaults = { sizeBytes, entropy, profiles, defaultProfile: sizeBytes > 20 * 1048576 ? "fast" : "full" };
    if (/\.(bin|rom|img)$/i.test(path)) return { ...defaults, candidates: [{ loader: "Raw Binary", language: null, compilerSpec: null, preferred: true, acceptsBaseAddress: true }] };
    return { ...defaults, candidates: [
      { loader: "Mach-O", language: "AARCH64:LE:64:v8A", compilerSpec: "default", preferred: true, acceptsBaseAddress: true },
      { loader: "Mach-O", language: "x86:LE:64:default", compilerSpec: "gcc", preferred: false, acceptsBaseAddress: true },
      { loader: "Raw Binary", language: null, compilerSpec: null, preferred: false, acceptsBaseAddress: true }] };
  },
  list_languages() { return LANGS; },
  close_program() {
    if (opening) throw { code: -32005, message: "Busy" };
    for (const c of [...cancels.values()]) c(); // in-flight decompiles fail Cancelled
    resetProgram(); opened = false; openId = null; activeSession = null;
    return {};
  },
  list_programs() {
    if (process.env.MOCK_LOCKED === "1") throw { code: -32006, message: "projects dir in use by another Ghidorita (mock)" };
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
  async open_program({ programId, analysis }, notify, rid) {
    const e = typeof programId === "string" && programs.get(programId);
    if (!e) throw { code: -32004, message: "NotFound" };
    return handlers.open_binary({ path: e.sourcePath, ...e.options, analysis, programId }, notify, rid); // programId: the catalog entry, not idFor(path) (seeded entries differ)
  },
  async open_binary(p, notify, rid) {
    const { path } = p;
    if (typeof path !== "string") bad("path");
    if (opening) throw { code: -32005, message: "Busy" };
    if (p.analysis !== undefined && p.analysis !== "background" && p.analysis !== "blocking") bad("analysis");
    const blocking = p.analysis === "blocking", opts = optsOf(p), profile = opts.profile === "fast" ? "fast" : "full";
    if (process.env.MOCK_SWITCH_FAILURES === "1" && dirty && !failedAutosave) {
      failedAutosave = true;
      throw { code: -32603, message: "Failed to flush pending changes" };
    }
    opening = true; openingRequest = rid; openCancelled = false;
    const programId = p.programId ?? idFor(path, opts), known = programs.get(programId), persisted = !!known;
    const stat = (analyzer, pct, done, total) => ({ phase: "analysis", pct, message: analyzer, analyzer, done, ...(total ? { total } : {}) });
    const steps = [{ phase: "import", pct: 0, message: `importing ${path}` }, { phase: "import", pct: 100, message: "imported" }];
    if (blocking && !(persisted && known.analysis === "done")) steps.push(stat("Decompiler Parameter ID", 0, 0), stat("Decompiler Parameter ID", 50, 0), stat("Function Start Search", -1, 1), stat("Stack", 30, 2, 8),
      stat("Stack", 90, 2, 8), stat("Subroutine References", -1, 3, 8), stat("ASCII Strings", 100, 4, 8), stat("Demangler", -1, 5));
    steps.push({ phase: "saving", pct: -1, message: "saving to project" }, { phase: "ready", pct: 100, message: "ready" });
    try {
      for (const st of steps) {
        notify("progress", { ...st, openId: rid }); await sleep(200);
        if (openCancelled) throw { code: -32002, message: "Cancelled" };
      }
      const name = path.split("/").pop();
      for (const cancel of [...cancels.values()]) cancel();
      resetProgram(); opened = false; // the swap point: the old program is only dropped now
      programs.set(programId, { programId, name, sourcePath: path, sizeBytes: 4096, analyzed: !!known?.analyzed || blocking, analysis: known?.analysis ?? (blocking ? "done" : "none"), analysisProfile: known?.analysisProfile ?? profile,
        funcs: known?.funcs, lastOpened: new Date().toISOString(), options: opts });
      if (stored.has(programId)) S = structuredClone(stored.get(programId));
      opened = true; openId = programId;
      const e = programs.get(programId);
      anFuncs = e.analysis === "done" ? NFUNC : e.funcs ?? Math.floor(NFUNC * 0.05); // a fresh import knows only the entry points
      an = { state: "idle", analysis: e.analysis, profile: e.analysisProfile, analyzer: "", done: 0, pct: e.analysis === "done" ? 100 : -1 };
      anNotify = notify;
      if (e.analysis !== "done") { if (blocking) { anFuncs = NFUNC; an.analysis = "done"; anRecord(); } else setTimeout(() => anStart(notify, an.profile), 50); } // background: new or interrupted analysis (re)starts, replied below as running
      activeSession = { programId, name, sessionId: randomUUID() };
      return { ...activeSession, persisted, analysis: { ...an, ...(!blocking && e.analysis !== "done" ? { state: "running", analysis: "partial" } : {}) } };
    } finally { opening = false; openingRequest = null; }
  },
  analysis_status() { return { ...an }; },
  start_analysis({ profile }, notify) {
    if (profile !== undefined && profile !== "full" && profile !== "fast") bad("profile");
    if (an.state === "running") throw { code: -32005, message: "Busy: analysis already running" };
    const want = profile ?? an.profile;
    if (an.analysis === "done" && (profile === undefined || profile === "fast" || an.profile === "full")) return { ...an, state: "done" }; // nothing to do
    anStart(notify, want);
    return { ...an };
  },
  cancel_analysis() { return { cancelled: anCancel() }; },

  cancel_open({ id } = {}) { const c = opening && !openCancelled && (id === undefined || id === openingRequest); if (c) openCancelled = true; return { cancelled: c }; },
  list_functions() {
    // fn_4000 is "huge" here (size 40000, > the UI's 30 KB warning) so the size warning and "Decompile anyway" can be exercised;
    // get_function_at keeps the real STEP so address-to-function lookups stay consistent
    const out = Array.from({ length: anFuncs }, (_, i) => ({ name: nameOf(i), entry: entryOf(i), size: i === HUGE ? 40000 : STEP, source: S.names.has(i) ? "user" : i % 7 === 0 ? "analysis" : "default" }));
    for (const [a, name] of S.created) out.push({ name, entry: hex(a), size: STRIDE * 4, source: "user" });
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
  listing_info: () => ({ ranges: SEGS.map((g) => ({ start: segAddr(g, 0), size: g.n * STRIDE })), totalBytes: SEGS.reduce((a, g) => a + g.n * STRIDE, 0) }),
  async listing_rows({ address, count, direction = "forward" }) {
    if (process.env.MOCK_SWITCH_FAILURES === "1" && activeSession?.name === "program-b" && !failedListing) {
      failedListing = true;
      throw { code: -32603, message: "Listing is temporarily unavailable" };
    }
    await sleep(20);
    const total = SEGS.reduce((a, g) => a + g.n, 0), idx = gIndex(address);
    const [from, to] = direction === "backward" ? [idx - count, idx] : [idx, idx + count];
    const out = [];
    for (let i = Math.max(0, from); i < Math.min(total, to); i++) out.push(rowAtG(i));
    return out;
  },
  // ---- reads ----
  get_bytes({ address, length }) { // the bytes the listing rows show (padded with 00 where a row shows only its first 16)
    if (!Number.isInteger(length) || length < 1 || length > 65536) bad("length");
    const f = segOf(address);
    if (!f) nf();
    const out = [];
    let skip = Number(BigInt("0x" + /([0-9a-f]+)$/i.exec(address)[1]) - (f[0].base + BigInt(f[1] * STRIDE)));
    for (let i = f[1]; out.length < length; i++, skip = 0) {
      if (i >= f[0].n) nf();
      const r = f[0].row(i), b = r.bytes.split(" ");
      for (let k = skip; k < r.length && out.length < length; k++) out.push(b[k] ?? "00");
    }
    return { address, length, bytes: out.join(" ") };
  },
  get_function_at: ({ address }) => funcAt(parseAddr(address)),
  export_symbols({ path }) { if (typeof path !== "string" || !path.startsWith("/")) bad("path"); return { path, functions: NFUNC, labels: 3, data: 2, comments: 1 }; },
  export_header({ path }) { if (typeof path !== "string" || !path.startsWith("/")) bad("path"); return { path, types: 2, functions: NFUNC, skipped: 0 }; },
  export_gzf({ path }) { if (typeof path !== "string" || !path.startsWith("/")) bad("path"); return { path, bytes: 4096 }; },
  top_symbols({ limit }) {
    const n = Math.min(limit ?? 30, 500), f = (i, group) => ({ name: nameOf(i), address: entryOf(i), kind: "function", refs: (i * 37) % 50 + 1, group });
    return [f(0, "entry"), ...[1, 2, 3].map((i) => f(i, "import")), ...Array.from({ length: n }, (_, k) => f(k + 4, "function")).sort((a, b) => b.refs - a.refs)];
  },
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
    if (n === parseInt(GLOBAL, 16)) return [3, 5, 9].map((j, k) => ({ from: hex(BASE + j * STEP + 8 * STRIDE), type: k ? "READ" : "WRITE", kind: k ? "read" : "write", function: nameOf(j) })).slice(0, lim);
    if (i < 0) return out;
    for (const c of CALLS) { // callers: caller = (callee - add) * inverse(mul) mod NFUNC
      const j = (((i - c[1]) % NFUNC + NFUNC) * INV[c[0]]) % NFUNC;
      if (calleeOf(j, c) === i) out.push({ from: hex(BASE + j * STEP + c[2] * STRIDE), type: c[3], kind: refKind(c[3]), function: nameOf(j) });
    }
    if (i % 5 === 0) out.push({ from: hex(BASE + ((i + 1) % NFUNC) * STEP + 11 * STRIDE), type: "DATA", kind: "data", function: nameOf((i + 1) % NFUNC) }); // a pointer to every 5th function
    out.sort((x, y) => parseInt(x.from, 16) - parseInt(y.from, 16));
    return out.slice(0, lim);
  },
  function_calls({ entry }) { // callers from xrefs_to (calls only), callees by CALLS; every 4th callee is a thunk to an external function
    const i = idxOfEntry(parseAddr(entry));
    if (i < 0) nf();
    const mk = (j) => ({ name: nameOf(j), entry: entryOf(j), external: false, thunk: j % 4 === 0, ...(j % 4 === 0 ? { target: { name: `ext_${j}`, entry: null, external: true } } : {}) });
    const callers = [...new Set(handlers.xrefs_to({ address: entry, limit: 1000 }).filter((x) => x.kind === "call").map((x) => (parseAddr(x.from) - BASE) / STEP | 0))].map(mk);
    const callees = [...new Set(CALLS.map((c) => calleeOf(i, c)))].map(mk);
    return { callers: callers.sort((a, b) => parseAddr(a.entry) - parseAddr(b.entry)), callees: callees.sort((a, b) => parseAddr(a.entry) - parseAddr(b.entry)) };
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
  load_coverage({ path }) {
    if (typeof path !== "string") bad("path");
    if (/missing/.test(path)) throw { code: -32004, message: "NotFound" };
    return { ranges: [{ start: hex(BASE), end: hex(BASE + STEP - 1) }] }; // mock: the first function was reached
  },
  variable_uses({ entry, name, timeoutSecs }, notify, rid) { // decompiler lane like decompile; iVar1 (as named now) has uses, nothing else does
    const n = parseAddr(entry), i = idxOfEntry(n);
    if (typeof name !== "string") bad("name");
    if (i < 0) nf();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cancels.delete(rid);
        if (name !== v(i, "iVar1")) return resolve([]);
        const u = (k, kind, type) => ({ from: hex(BASE + i * STEP + k * STRIDE), type, kind, function: nameOf(i) });
        resolve([u(4, "write", "CALL"), u(5, "read", "INT_NOTEQUAL"), u(6, "read", "CALL"), u(7, "read", "INT_ADD"), u(7, "write", "CALL"), u(8, "read", "COPY")]);
      }, 60);
      cancels.set(rid, () => { clearTimeout(t); cancels.delete(rid); reject({ code: -32002, message: "Cancelled" }); });
    });
  },
  debug_attach({ host = "localhost", port = 1234 }, notify) {
    if (dbg.state !== "detached") throw { code: -32005, message: `Already attached to ${dbg.target}` };
    if (port === 1) throw { code: -32008, message: `Connection refused by ${host}:${port}. Is QEMU running with -gdb tcp::${port}?` };
    dbgNotify = notify; dbg.target = `${host}:${port}`; dbg.error = ""; dbg.stop = 0; dbgStopAt(BASE + STEP + 0x10); return {};
  },
  debug_detach(_, notify) { dbgNotify = notify; clearTimeout(dbgTimer); if (dbg.state !== "detached") { dbg.state = "detached"; dbg.error = ""; dbgPublish(); } return {}; },
  debug_status() { return { state: dbg.state, target: dbg.target, stop: dbg.stop, offset: "0x0", breakpoints: dbg.bps.map(hex), ...(dbg.state === "stopped" ? { address: hex(dbg.pc), registers: dbgRegs() } : {}) }; },
  debug_breakpoint({ address }, notify) {
    const a = parseAddr(address); if (a < 0) bad("address");
    dbgNotify = notify; dbg.bps = dbg.bps.includes(a) ? dbg.bps.filter((x) => x !== a) : [...dbg.bps, a]; dbgPublish(); return {};
  },
  debug_step({ mode = "instruction", boundaries } = {}, notify) {
    dbgNotify = notify; dbgNeed("stopped"); const f = dbg.pc - ((dbg.pc - BASE) % STEP);
    if (mode === "statement") { // the next boundary after the pc, else the first one (the sidecar stops at a boundary, a breakpoint or outside the function)
      const b = (boundaries ?? []).map(parseAddr).filter((a) => a >= 0).sort((x, y) => x - y); if (!b.length) bad("boundaries");
      dbgStopAt(b.find((a) => a > dbg.pc) ?? b[0]); return {};
    }
    if (mode === "into" || mode === "out") { // into: the next boundary; out: the instruction after the function (a return lands in the caller)
      if (mode === "out") { dbgStopAt(f + STEP); return {}; }
      const b = (boundaries ?? []).map(parseAddr).filter((a) => a >= 0).sort((x, y) => x - y); if (!b.length) bad("boundaries");
      dbgStopAt(b.find((a) => a > dbg.pc) ?? b[0]); return {};
    }
    dbgStopAt(f + ((dbg.pc - f + 4) % 0x30)); return {};
  },
  debug_memory({ address, length, dataType }) { // bytes follow the address and the stop count; a type gives int components (an array of n, else one)
    dbgNeed("stopped"); const a = parseAddr(address); if (a < 0) bad("address");
    const arr = /\[(\d+)\]$/.exec(dataType ?? ""), n = length ?? (dataType ? (arr ? +arr[1] * 4 : 4) : 64);
    const bytes = Array.from({ length: n }, (_, k) => ((a + k + dbg.stop) & 0xff).toString(16).padStart(2, "0")).join("");
    const items = dataType ? Array.from({ length: arr ? +arr[1] : 1 }, (_, i) => ({ offset: i * 4, length: 4, type: dataType.replace(/\[\d+\]$/, ""), name: arr ? `[${i}]` : "", value: String(a + i + dbg.stop) })) : undefined;
    return { address: hex(a), bytes, ...(items ? { items } : {}) };
  },
  debug_values({ entry }) { // the variables of the mock decompile, their values follow the stop count
    dbgNeed("stopped"); const i = idxOfEntry(parseAddr(entry)); if (i < 0) nf();
    const mk = (name, kind, type, v, where) => ({ name, kind, type, size: 4, where, value: String(v), raw: "0x" + (v >>> 0).toString(16).padStart(8, "0") });
    return { pc: hex(dbg.pc), items: [mk(v(i, "param_1"), "param", "int", dbg.stop * 3, "r0"), mk(v(i, "iVar1"), "local", "int", dbg.stop, "stack-8"), mk("g_state", "global", "int", dbg.stop >> 1, GLOBAL)] };
  },
  debug_continue(_, notify) {
    dbgNotify = notify; dbgNeed("stopped"); const from = dbg.pc; dbg.state = "running"; dbgPublish();
    const next = [...dbg.bps].sort((x, y) => x - y).find((b) => b > from) ?? dbg.bps.slice().sort((x, y) => x - y)[0];
    if (next !== undefined) dbgTimer = setTimeout(() => dbgStopAt(next), 250);
    return {};
  },
  debug_pause(_, notify) { dbgNotify = notify; dbgNeed("running"); clearTimeout(dbgTimer); dbgStopAt(BASE + STEP + 0x08); return {}; },
  call_graph({ entry, depth, to, maxDepth }) { // the CALLS pattern (three callees each, three callers each); same rules as the sidecar
    const i = idxOfEntry(parseAddr(entry)), t = to === undefined ? -1 : idxOfEntry(parseAddr(to));
    if (i < 0 || (to !== undefined && t < 0)) nf();
    const outs = (u) => CALLS.map((c) => calleeOf(u, c)), ins = (u) => CALLS.map((c) => (((u - c[1]) % NFUNC + NFUNC) * INV[c[0]]) % NFUNC).filter((j, k) => calleeOf(j, CALLS[k]) === u);
    const nodes = new Set([i]), edges = new Map(), edge = (a, b) => { if (nodes.size < 300 || (nodes.has(a) && nodes.has(b))) { nodes.add(a); nodes.add(b); edges.set(a + ">" + b, (edges.get(a + ">" + b) ?? 0) + 1); } };
    if (to === undefined) {
      const d = Math.min(6, parseInt0(depth, 2, "depth"));
      for (const [step, add] of [[outs, (u, v) => edge(u, v)], [ins, (u, v) => edge(v, u)]]) { let f = [i]; const seen = new Set(f); for (let k = 0; k < d; k++) { const n = []; for (const u of f) for (const v of step(u)) { add(u, v); if (!seen.has(v)) { seen.add(v); n.push(v); } } f = n; } }
    } else {
      const md = Math.min(30, parseInt0(maxDepth, 10, "maxDepth")), back = new Map([[t, 0]]), q = [t];
      nodes.add(t);
      while (q.length) { const v = q.shift(); if (back.get(v) >= md) continue; for (const u of ins(v)) if (!back.has(u)) { back.set(u, back.get(v) + 1); q.push(u); } }
      const lim = Math.min(md, (back.get(i) ?? 0) + 1); // the shortest route and those one call longer
      if (back.has(i)) { const fwd = new Map([[i, 0]]), q2 = [i]; while (q2.length) { const u = q2.shift(); for (const v of outs(u)) { const d = fwd.get(u) + 1; if (back.has(v) && d + back.get(v) <= lim) { edge(u, v); if (!fwd.has(v)) { fwd.set(v, d); q2.push(v); } } } } }
    }
    return { nodes: [...nodes].map((u) => ({ entry: entryOf(u), name: nameOf(u), kind: "function" })),
      edges: [...edges].map(([k, n]) => { const [a, b] = k.split(">").map(Number); return { from: entryOf(a), to: entryOf(b), sites: n }; }), truncated: nodes.size >= 300 };
  },
  function_graph({ entry }) { // four blocks: entry -> (true: then | false: else) -> join; the graph's second block gets C, the others assembly
    const n = parseAddr(entry), i = idxOfEntry(n);
    if (i < 0) nf();
    const at = (k) => hex(n + k * STRIDE), blk = (k, len, lines, kind = "asm") => ({ start: at(k), end: hex(n + (k + len) * STRIDE - 1), kind, lines });
    return { blocks: [blk(0, 3, [`${at(0)}  push rbp`, `${at(1)}  mov rbp, rsp`, `${at(2)}  jz ${at(6)}`]), blk(3, 3, ["  puts(\"then\");", "  iVar1 = 1;"], "c"), blk(6, 2, [`${at(6)}  xor eax, eax`, `${at(7)}  jmp ${at(8)}`]), blk(8, 2, [`${at(8)}  pop rbp`, `${at(9)}  ret`])],
      edges: [{ from: at(0), to: at(3), kind: "false" }, { from: at(0), to: at(6), kind: "true" }, { from: at(3), to: at(8), kind: "uncond" }, { from: at(6), to: at(8), kind: "uncond" }] };
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
  list_strings({ offset, limit, minLength, query, referencedOnly }) {
    const off = parseInt0(offset, 0, "offset"), lim = parseInt0(limit, 100, "limit"), min = parseInt0(minLength, 4, "minLength");
    if (query !== undefined && typeof query !== "string") bad("query");
    const q = (query ?? "").trim().toLowerCase();
    const all = Array.from({ length: 300 }, (_, k) => { const value = `mock string #${k}${"x".repeat(k % 20)}`; return { address: hex(BASE + (k * 6000 + 11) * STRIDE), value, length: value.length + 1 }; })
      .map((s, k) => (k % 3 === 0 ? { ...s, refs: 0 } : { ...s, refs: (k % 4) + 1, refFrom: Array.from({ length: Math.min(3, (k % 4) + 1) }, (_, j) => ({ from: entryOf((k * 7 + j) % NFUNC), function: nameOf((k * 7 + j) % NFUNC) })) })) // every third string is unreferenced
      .filter((s) => s.value.length >= min && s.value.toLowerCase().includes(q) && (!referencedOnly || s.refs > 0) && S.data.get(parseAddr(s.address))?.mnemonic !== "??"); // clear_code removes a string
    return { total: all.length, items: all.slice(off, off + lim) };
  },
  list_undefined_refs({ offset, limit }) { // fake: 40 references into undefined words; define_data on a target removes its row
    const off = parseInt0(offset, 0, "offset"), lim = Math.min(5000, parseInt0(limit, 500, "limit"));
    const all = Array.from({ length: 40 }, (_, k) => ({ address: hex(BASE + (k * 4000 + 5) * STRIDE), type: ["read", "write", "pointer"][k % 3], from: entryOf(k % NFUNC), function: nameOf(k % NFUNC) }))
      .filter((r) => { const d = S.data.get(parseAddr(r.address)); return !d || d.mnemonic === "??"; });
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
    const q = query.toLowerCase();
    return [...[...S.dt.values()].map((t) => ({ ...nodeOf(t), source: "program" })), ...DATA_TYPES.map((d) => ({ ...d, kind: "builtin", source: "builtin" }))].filter((d) => d.name.toLowerCase().includes(q)).slice(0, parseInt0(limit, 50, "limit"));
  },
  // ---- data types ----
  dt_sources: () => [{ id: "program", name: "mock", writable: true }, { id: "builtin", name: "BuiltInTypes", writable: false }],
  dt_children({ source = "program", path = "/" }) {
    if (typeof path !== "string") bad("path");
    if (source === "builtin") { if (path !== "/") nf(); return { categories: [], types: DATA_TYPES.map((d) => ({ name: d.name, path: d.path, size: d.size, kind: "builtin" })) }; }
    if (source !== "program") bad("source");
    const cats = catSet(); if (!cats.has(path)) nf();
    const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return { categories: [...cats].filter((c) => c !== "/" && parentOf(c) === path).map((c) => ({ name: c.split("/").pop(), path: c })).sort(byName),
      types: [...S.dt.values()].filter((t) => parentOf(t.path) === path).map(nodeOf).sort(byName) };
  },
  get_data_type({ path, source = "program" }) {
    if (typeof path !== "string") bad("path");
    if (source === "builtin") { const d = DATA_TYPES.find((d) => d.path === path); if (!d) nf(); return { name: d.name, path, size: d.size, kind: "builtin", source, writable: false, description: "", archive: null }; }
    if (source !== "program") bad("source");
    return detail(getDt(path));
  },
  create_data_type({ kind, name, category = "/", size, base }, notify) {
    if (!["struct", "union", "enum", "typedef", "pointer", "category"].includes(kind)) bad("kind");
    const cat = catOf(category);
    if (kind === "pointer") { const r = resolveType(base, true); return edit(`Create pointer`, notify, null, ["type"], () => { S.dt.set(`/${r.display} *`, { kind: "pointer", name: r.display + " *", path: `/${r.display} *`, size: 8, base: r.display, basePath: r.path }); return { path: `/${r.display} *` }; }); }
    reqName(name);
    if (kind === "category") { const p = join(cat, name); if (catSet().has(p)) bad("duplicate"); return edit(`Create category ${name}`, notify, null, ["type"], () => { S.cats.add(p); return { path: p }; }); }
    const sz = size === undefined ? (kind === "enum" ? 4 : 0) : size;
    if (!Number.isInteger(sz) || sz < 0 || (kind === "enum" && ![1, 2, 4, 8].includes(sz))) bad("size");
    const t = { kind, name, path: join(cat, name), comps: [], values: [], size: sz };
    if (kind === "struct") t.comps = fill(sz);
    if (kind === "typedef") { const r = resolveType(base, true); Object.assign(t, { size: r.size, base: r.display, basePath: r.path }); }
    if (S.dt.has(t.path)) bad("duplicate");
    return edit(`Create ${kind} ${name}`, notify, null, ["type"], () => { addType(t); S.cats.add(cat); return { path: t.path }; });
  },
  delete_data_type({ path, category }, notify) {
    if (typeof path !== "string") bad("path");
    if (category) {
      if (!catSet().has(path)) nf();
      if (path === "/" || [...S.dt.values()].some((t) => t.path.startsWith(path + "/")) || [...catSet()].some((c) => c.startsWith(path + "/"))) bad("category not empty");
      return edit(`Delete ${path}`, notify, null, ["type"], () => { S.cats.delete(path); });
    }
    getDt(path);
    return edit(`Delete ${path}`, notify, null, ["type"], () => { S.dt.delete(path); });
  },
  rename_data_type({ path, newName }, notify) {
    const t = getDt(path); reqName(newName);
    const np = join(parentOf(path), newName);
    if (S.dt.has(np)) bad("duplicate");
    return edit(`Rename data type ${t.name} to ${newName}`, notify, null, ["type"], () => {
      S.dt.delete(path); Object.assign(t, { name: newName, path: np }); S.dt.set(np, t);
      for (const d of S.data.values()) if (d.ref?.path === path) { d.ref.path = np; d.mnemonic = newName; }
      return { path: np };
    });
  },
  edit_struct({ path, op }, notify) {
    const t = getDt(path);
    if (t.kind !== "struct" && t.kind !== "union") bad("not a struct or union");
    if (!op || typeof op !== "object") bad("op");
    const un = t.kind === "union";
    return edit(`Edit ${t.name}: ${op.op}`, notify, null, ["type"], () => {
      const c = t.comps, n = c.length;
      switch (op.op) {
        case "add": c.push(mkComp(op, t)); break;
        case "insert": { if (!Number.isInteger(op.ordinal) || op.ordinal < 0 || op.ordinal > n) bad("ordinal"); c.splice(op.ordinal, 0, mkComp(op, t)); break; }
        case "set": {
          const i = ord(op, n), old = c[i];
          if (old.undef && op.type === undefined) bad("give a type for an undefined byte");
          const nc = op.type !== undefined ? mkComp({ ...op, type: op.type }, t) : { ...old };
          if (op.name !== undefined) nc.name = optStr(op.name); else nc.name = old.name;
          if (op.comment !== undefined) nc.comment = optStr(op.comment); else nc.comment = old.comment;
          if (un) { c[i] = nc; break; }
          let take = 1, need = nc.len - old.len; // a bigger type consumes following filler; a smaller one leaves filler
          while (need > 0) { const nx = c[i + take]; if (!nx || !nx.undef) bad("not enough room"); need -= nx.len; take++; }
          c.splice(i, take, nc, ...(need < 0 ? fill(-need) : []));
          break;
        }
        case "delete": c.splice(ord(op, n), 1); break;
        case "clear": { const i = ord(op, n); if (un) c.splice(i, 1); else c.splice(i, 1, ...fill(c[i].len)); break; }
        case "move": { const i = ord(op, n); if (!un && !t.packed) bad("unpacked structure fields have fixed offsets"); if (!Number.isInteger(op.to) || op.to < 0 || op.to >= n) bad("to"); c.splice(op.to, 0, ...c.splice(i, 1)); break; }
        case "resize": {
          if (un || t.packed || !Number.isInteger(op.size) || op.size < 0) bad("resize");
          const cur = sizeOf(t);
          if (op.size >= cur) c.push(...fill(op.size - cur));
          else { while (sizeOf(t) > op.size) c.pop(); c.push(...fill(op.size - sizeOf(t))); }
          break;
        }
        case "pack": { if (typeof op.packed !== "boolean") bad("packed"); t.packed = op.packed; t.packingValue = op.packed ? op.packingValue || null : null; if (op.packed) t.comps = c.filter((x) => !x.undef); break; }
        default: bad("op");
      }
      return {};
    });
  },
  edit_enum({ path, op }, notify) {
    const t = getDt(path);
    if (t.kind !== "enum") bad("not an enum");
    if (!op || typeof op !== "object") bad("op");
    return edit(`Edit ${t.name}: ${op.op}`, notify, null, ["type"], () => {
      if (op.op === "set") {
        reqName(op.name); const old = op.oldName ?? op.name, value = parseEnumValue(op.value);
        if (old !== op.name && t.values.some((v) => v.name === op.name)) bad("duplicate");
        t.values = t.values.filter((v) => v.name !== old); t.values.push({ name: op.name, value });
      } else if (op.op === "remove") { if (!t.values.some((v) => v.name === op.name)) nf(); t.values = t.values.filter((v) => v.name !== op.name); }
      else if (op.op === "resize") { if (![1, 2, 4, 8].includes(op.size)) bad("size"); t.size = op.size; }
      else bad("op");
      return {};
    });
  },
  auto_create_structure({ entry, name, structName }, notify) {
    const i = idxOfEntry(parseAddr(entry)), o = Object.keys(VARS).find((o) => i >= 0 && v(i, o) === name);
    if (!o) nf();
    if (structName !== undefined) reqName(structName);
    const nm = structName ?? "auto_struct", path = "/auto_structs/" + nm;
    if (S.dt.has(path)) bad("duplicate");
    return edit(`Auto create structure in ${nameOf(i)}`, notify, [fnRange(i)], ["type", "function"], () => {
      S.dt.set(path, { kind: "struct", name: nm, path, size: 0, comps: [{ len: 8, display: "long", typePath: "/long", name: "field0_0x0" }, ...fill(8)] });
      S.cats.add("/auto_structs"); S.types.set(`${i}|${o}`, nm + " *");
      return { path };
    });
  },
  create_struct_from_data({ address, length, name, category = "/", apply = true }, notify) {
    const n = parseAddr(address), cat = catOf(category);
    reqName(name);
    if (!Number.isInteger(length) || length < 1 || n < BASE || n + length > BASE + ROWS * STRIDE) bad("range");
    const comps = []; let off = 0;
    while (off < length) { // the mock's listing is all instructions except what define_data created
      const d = S.data.get(n + off);
      if (!d) bad("instructions cannot be part of a structure");
      const len = d.ref ? sizeOf(S.dt.get(d.ref.path)) * d.ref.count : d.length;
      if (off + len > length) bad("the range must start and end on data item boundaries");
      comps.push({ len, display: d.mnemonic, typePath: d.ref?.path ?? "/" + d.mnemonic }); off += len;
    }
    const t = { kind: "struct", name, path: join(cat, name), comps, size: 0 };
    if (S.dt.has(t.path)) bad("duplicate");
    return edit(`Create structure ${name}`, notify, apply ? [{ start: hex(n), end: hex(n + length - 1) }] : null, apply ? ["type", "data"] : ["type"], () => {
      addType(t); S.cats.add(cat);
      if (apply) S.data.set(n, { mnemonic: name, length, ref: { path: t.path, count: 1 } });
      return { path: t.path };
    });
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
  list_bookmarks({ type, query, offset, limit, sort, desc }) { // your Note bookmarks plus a few "analyzer" ones to exercise the type filter
    const all = [...S.bookmarks.values()].map((b) => ({ address: hex(b.n), type: "Note", category: b.category, comment: b.comment }));
    for (let i = 0; i < 40; i++) all.push({ address: hex(BASE + (i * 7 + 1) * STRIDE), type: i % 4 ? "Analysis" : "Warning", category: i % 4 ? "Found Code" : "Bad Instruction", comment: `analyzer ${i}` });
    const counts = new Map();
    for (const b of all) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
    const q = (query ?? "").toLowerCase();
    const items = all.filter((b) => (type === undefined || b.type === type) && (!q || b.category.toLowerCase().includes(q) || b.comment.toLowerCase().includes(q)));
    const key = { address: (b) => parseInt(b.address, 16), type: (b) => b.type.toLowerCase(), category: (b) => b.category.toLowerCase() }[sort ?? "address"];
    if (!key) bad("sort");
    items.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : parseInt(x.address, 16) - parseInt(y.address, 16)) * (desc ? -1 : 1));
    return { total: items.length, types: [...counts].sort().map(([t, count]) => ({ type: t, count })), items: items.slice(offset ?? 0, (offset ?? 0) + Math.min(limit ?? 100, 1000)) };
  },
  set_bookmark({ address, category, comment }, notify) {
    const n = parseAddr(address);
    if (typeof category !== "string" || typeof comment !== "string" || n < BASE || n >= BASE + ROWS * STRIDE) bad("category/comment/address");
    return edit("Set bookmark", notify, [{ start: hex(n), end: hex(n) }], ["bookmark"], () => { S.bookmarks.set(`${n}|${category}`, { n, category, comment }); });
  },
  remove_bookmark({ address, type, category }, notify) {
    const n = parseAddr(address);
    if (category !== undefined && typeof category !== "string") bad("category");
    const keys = type === "Note" ? [...S.bookmarks].filter(([, b]) => b.n === n && (category === undefined || b.category === category)).map(([k]) => k) : []; // omitted category = all of them
    if (!keys.length) nf();
    return edit("Remove bookmark", notify, [{ start: hex(n), end: hex(n) }], ["bookmark"], () => { for (const k of keys) S.bookmarks.delete(k); });
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
  stack_frame({ entry }) {
    const i = idxOfEntry(parseAddr(entry));
    if (i < 0) nf();
    const slots = [{ offset: -16, size: 8, name: "local_10", dataType: "long", parameter: false, source: "default" }, { offset: -8, size: 4, name: "count", dataType: "int", parameter: false, source: "user" },
      { offset: 8, size: 8, name: "param_1", dataType: "char *", parameter: true, source: "analysis" }];
    return { entry: hex(BASE + i * STEP), name: nameOf(i), localSize: 16, parameterSize: 8, slots };
  },
  // decompilerEdits: the mock's decompiler has no numbers or unions to point at, so these only validate and record an undo step
  set_equate({ address, value, size, name }, notify) {
    const n = parseAddr(address);
    if (!/^-?\d+$/.test(String(value)) || ![1, 2, 4, 8].includes(size)) bad("value/size");
    validName(name);
    return edit("Set equate " + name, notify, [{ start: hex(n), end: hex(n) }], ["symbol"], () => {});
  },
  set_function_no_return({ entry, noReturn }, notify) {
    const i = idxOfEntry(parseAddr(entry));
    if (i < 0) nf();
    if (noReturn !== undefined && typeof noReturn !== "boolean") bad("noReturn");
    return edit("Mark no return", notify, [fnRange(i)], ["function"], () => {});
  },
  split_variable({ entry, name, address, newName }, notify) {
    const i = idxOfEntry(parseAddr(entry));
    if (i < 0 || !Object.keys(VARS).some((o) => v(i, o) === name)) nf();
    validName(newName); parseAddr(address);
    bad("nothing to split: the mock's variables are one use only");
  },
  force_union_field() { bad("the mock has no unions"); },
  define_data({ address, dataType }, notify) {
    const n = parseAddr(address);
    if (typeof dataType !== "string" || n < BASE || n >= BASE + ROWS * STRIDE) bad("dataType/address");
    const r = resolveType(dataType), user = r.kind === "struct" || r.kind === "union" || r.kind === "enum" || r.kind === "typedef";
    if (r.size <= 0) bad("dataType");
    return edit("Define data", notify, [{ start: hex(n), end: hex(n + r.size - 1) }], ["data", "code"], () => { S.data.set(n, { mnemonic: r.display, length: r.size, ref: user ? { path: r.path, count: 1 } : undefined }); });
  },
  clear_code({ address, length }, notify) {
    const n = parseAddr(address), len = parseInt0(length, STRIDE, "length");
    if (n < BASE || n >= BASE + ROWS * STRIDE || len < 1) bad("address/length");
    return edit("Clear code", notify, [{ start: hex(n), end: hex(n + len - 1) }], ["code", "data"], () => { for (let a = n; a < n + len; a += STRIDE) S.data.set(a, { mnemonic: "??", length: STRIDE }); });
  },
  save(_, notify) { // like Ghidra: history is dropped, dirty cleared
    anCancel(); // saving needs no open transaction: a running analysis is cancelled (state partial) first
    if (!dirty) return { saved: false, undoHistoryCleared: false };
    autosave(); dirty = false; undoStack.length = 0; redoStack.length = 0;
    notify("program_changed", { ranges: [], kinds: [], undo: undoState() });
    return { saved: true, undoHistoryCleared: true };
  },
  undo(_, notify) { return step(undoStack, redoStack, "before", notify); },
  redo(_, notify) { return step(redoStack, undoStack, "after", notify); },
};
function step(from, to, side, notify) {
  busyAnalysis();
  const e = from.pop();
  if (!e) bad("nothing to " + (side === "before" ? "undo" : "redo"));
  S = structuredClone(e[side]); to.push(e); dirty = true;
  changed(notify, null, ["other"]);
  return undoState();
}

const unscoped = new Set(["provider_info", "active_session", "open_binary", "open_program", "import_candidates", "list_languages", "list_programs", "delete_program"]);
const token = process.env.SIDECAR_TOKEN;
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: ({ req }) => !token || req.url === "/" + token }, () => console.log(wss.address().port));
wss.on("connection", (ws) => {
  let versioned = false;
  ws.on("message", async (data) => {
    const req = JSON.parse(data.toString());
    if (req.method === "cancel_open") return ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: handlers.cancel_open(req.params) }));
    if (req.method === "cancel_decompile" || req.method === "cancel_search") { // bypasses the queue
      const c = cancels.get(req.params?.id); if (c) c();
      return ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { cancelled: !!c } }));
    }
    try {
      if (req.method === "provider_info") versioned = true;
      const id = activeSession?.sessionId;
      const notify = (method, params) => ws.send(JSON.stringify({ // the session is read at send time: an analysis started by open_binary keeps this closure after the swap
        jsonrpc: "2.0", method, params: method === "program_changed" || method === "analysis_state" || method === "debug_state" ? { ...params, sessionId: activeSession?.sessionId } : params,
      }));
      const h = Object.hasOwn(handlers, req.method) && handlers[req.method];
      if (!h) throw { code: -32601, message: "MethodNotFound" };
      if (!unscoped.has(req.method) && (versioned || req.sessionId !== undefined) && (!id || req.sessionId !== id)) {
        throw { code: -32007, message: "Stale program session" };
      }
      if (!unscoped.has(req.method) && req.method !== "close_program" && (!opened || opening)) throw { code: -32001, message: "NoProgram" };
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
