import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

globalThis.window = { host: { recentAdd: async () => {} } };
const r = await build({ entryPoints: [new URL("../src/renderer/store/session.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "node" });
const { createSession } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fn = (entry) => ({ name: "f" + entry, entry, size: 4 });
/** A provider in memory: `opens` hands out sessions, `held` makes the next open wait for the test. */
function fake() {
  const b = { held: null, active: null, n: 0, closed: 0, undo: { canUndo: false, canRedo: false, dirty: false }, onProgress: null };
  const ops = (session) => ({
    listing: { info: async () => ({ totalBytes: 16, ranges: [{ start: "0x1000", size: 16 }] }), rows: async () => [] },
    functions: { list: async () => [fn("0x1000")], containing: async () => null },
    history: { state: async () => b.undo, save: async () => ({ saved: true }) },
  });
  b.backend = {
    capabilities: new Set(["undo", "save"]),
    lifecycle: {
      open: (path, _o, onProgress) => {
        b.onProgress = onProgress;
        const session = { sessionId: "s" + ++b.n, programId: "p", name: path, persisted: false };
        const gate = b.held; b.held = null;
        const result = gate ? gate.promise.then((fail) => { if (fail) throw fail; b.active = session; return session; }) : Promise.resolve().then(() => (b.active = session));
        return { result, cancel: async () => true };
      },
      active: async () => b.active,
      close: async () => { b.closed++; b.active = null; },
    },
    events: { onChange: () => () => {}, onError: () => () => {} },
    projects: {}, imports: {},
    program: (session) => ops(session),
  };
  return b;
}
const mk = (b) => createSession(b.backend, { autotest: true });

test("open selects the program, reads the browsing data, announces a reset", async () => {
  const b = fake(), s = mk(b); let resets = 0; s.onReset(() => resets++);
  await s.open("/a");
  const st = s.store.getState();
  assert.equal(st.program.session.name, "/a"); assert.equal(st.funcs.length, 1); assert.ok(st.map); assert.equal(st.opening, null);
  assert.equal(resets, 1);
  await s.open("/b"); // a replacement is another session: reset again
  assert.equal(s.program().session.name, "/b"); assert.equal(resets, 2);
});

test("a failed open leaves the active program and its view alone", async () => {
  const b = fake(), s = mk(b);
  await s.open("/a");
  const before = s.program(); let resets = 0; s.onReset(() => resets++);
  const gate = deferred(); b.held = gate;
  const opening = s.open("/bad");
  assert.ok(s.store.getState().opening);
  gate.resolve(Object.assign(new Error("nope"), { kind: "notFound" }));
  await opening;
  assert.equal(s.program(), before); assert.equal(resets, 0);
  assert.match(s.store.getState().notice, /Could not open/); assert.equal(s.store.getState().opening, null);
});

test("a second open while one runs is ignored; closing resets", async () => {
  const b = fake(), s = mk(b);
  const gate = deferred(); b.held = gate;
  const first = s.open("/a"); const second = s.open("/b");
  gate.resolve(null); await first; await second;
  assert.equal(b.n, 1);
  let resets = 0; s.onReset(() => resets++);
  await s.closeProgram();
  assert.equal(s.program(), null); assert.equal(resets, 1); assert.equal(b.closed, 1);
});

test("program_changed: a save only updates undo; an edit is announced with the program; during an open it is held", async () => {
  const b = fake(), s = mk(b);
  await s.open("/a");
  const seen = []; s.onChanged((p) => seen.push(p));
  const id = s.program().session.sessionId;
  const dirty = { canUndo: true, canRedo: false, dirty: true, undoName: "x" };
  s.programChanged(id, { ranges: [], kinds: [], undo: dirty });
  assert.equal(seen.length, 0); assert.equal(s.store.getState().undo.dirty, true);
  s.programChanged("other-session", { ranges: null, kinds: ["other"], undo: dirty });
  assert.equal(seen.length, 0);
  s.programChanged(id, { ranges: [{ start: "0x1000", end: "0x1003" }], kinds: ["symbol"], undo: dirty });
  assert.equal(seen.length, 1); assert.equal(s.views.getState().dataVersion, 1);

  const gate = deferred(); b.held = gate;
  const opening = s.open("/a2");
  s.programChanged(id, { ranges: [{ start: "0x1000", end: "0x1003" }], kinds: ["symbol"], undo: dirty });
  assert.equal(seen.length, 1);              // held while the open runs
  gate.resolve(null); await opening;
  assert.equal(seen.length, 1);              // the new session replaced the one the change belonged to: dropped
});

test("cancelOpen asks the job, progress is shown only while opening", async () => {
  const b = fake(), s = mk(b);
  const gate = deferred(); b.held = gate;
  const opening = s.open("/a");
  b.onProgress({ phase: "import", pct: 10, message: "" });
  assert.equal(s.store.getState().progress.pct, 10);
  s.cancelOpen();
  assert.equal(s.store.getState().opening.cancelling, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.store.getState().opening.cancelling, true); // the provider accepted: stays cancelling until the open ends
  gate.resolve(null); await opening;
  assert.equal(s.store.getState().progress, null);
});
