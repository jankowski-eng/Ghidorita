import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

// one bundle, so changeLog and the test share attribution.ts's WeakMap
const src = new URL("../src/", import.meta.url).pathname;
const out = await build({ stdin: { contents: `export * from "./renderer/changeLog"; export * from "./agent/attribution";`, resolveDir: src, loader: "ts" }, bundle: true, format: "esm", write: false, platform: "node" });
const { ChangeLog, tagParams } = await import("data:text/javascript," + encodeURIComponent(out.outputFiles[0].text));
const live = (l) => l.items.filter((c) => !c.undone).map((c) => c.label);

test("edits are logged, reads are not", () => {
  const l = new ChangeLog();
  l.record("list", {}, []);
  l.record("renameSymbol", { address: "0x10", newName: "main" }, {});
  l.record("setComment", { address: "0x10", kind: "eol", text: "x" }, {});
  assert.deepEqual(live(l), ["Rename to main", "Comment (eol)"]);
});

test("undo/redo flip entries; a new edit drops the undone ones", () => {
  const l = new ChangeLog();
  l.record("renameSymbol", { address: "0x1", newName: "a" }, {});
  l.record("renameSymbol", { address: "0x2", newName: "b" }, {});
  l.record("undo", {}, {});
  assert.deepEqual(live(l), ["Rename to a"]);
  l.record("redo", {}, {});
  assert.deepEqual(live(l), ["Rename to a", "Rename to b"]);
  l.record("undo", {}, {});
  l.record("defineData", { address: "0x3", dataType: "int" }, {});
  assert.equal(l.items.length, 2);
  l.record("redo", {}, {}); // nothing to redo after a new edit
  assert.deepEqual(live(l), ["Rename to a", "Define int"]);
});

test("a save freezes earlier entries: undo skips them; open clears", () => {
  const l = new ChangeLog();
  l.record("renameSymbol", { address: "0x1", newName: "a" }, {});
  l.record("save", {}, { saved: true, undoHistoryCleared: true });
  l.record("undo", {}, {});
  assert.equal(l.items[0].undone, false);
  assert.equal(l.items[0].saved, true);
  l.clear();
  assert.equal(l.items.length, 0);
});

test("rename -> set bookmark -> undo -> redo: undo marks the bookmark, not the rename", () => {
  const l = new ChangeLog();
  l.record("renameSymbol", { address: "0x1", newName: "a" }, {});
  l.record("setBookmark", { address: "0x1", category: "triage", comment: "x" }, {});
  assert.deepEqual(live(l), ["Rename to a", "Bookmark triage"]);
  l.record("undo", {}, {});
  assert.deepEqual(live(l), ["Rename to a"]);
  assert.equal(l.items[1].undone, true);
  l.record("redo", {}, {});
  assert.deepEqual(live(l), ["Rename to a", "Bookmark triage"]);
  l.record("removeBookmark", { address: "0x1", type: "Note", category: "triage" }, {});
  l.record("undo", {}, {});
  assert.deepEqual(live(l), ["Rename to a", "Bookmark triage"]);
});

test("every edit the rpc adapter logs is a change-log entry (an unknown name would let undo mark the wrong entry)", () => {
  const src = readFileSync(new URL("../src/renderer/rpc.ts", import.meta.url), "utf8");
  const names = [...src.matchAll(/\bedit\(\s*"[A-Za-z]+",\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 20, "found the adapter's edit() calls");
  const l = new ChangeLog();
  for (const n of names) {
    if (n === "undo" || n === "redo" || n === "save") continue; // record() handles those itself
    const before = l.items.length;
    l.record(n, {}, {});
    assert.equal(l.items.length, before + 1, `${n} is logged by rpc.ts but unknown to changeLog.ts`);
  }
});

test("reconcile: an analysis that saved clears the history, so earlier edits are saved and no longer undoable", () => {
  const l = new ChangeLog();
  l.record("renameSymbol", { address: "0x1", newName: "a" }, {});
  l.reconcile({ canUndo: true, canRedo: false, dirty: true }); // an ordinary event changes nothing
  assert.equal(l.items[0].saved, false);
  l.reconcile({ canUndo: false, canRedo: false, dirty: false }); // the analysis saved
  assert.equal(l.items[0].saved, true);
  l.record("undo", {}, {}); // the provider has nothing to undo; the saved entry must not flip
  assert.deepEqual(live(l), ["Rename to a"]);
});

test("reconcile: history cleared but the save failed keeps the edit unsaved and not undoable", () => {
  const l = new ChangeLog();
  l.record("renameSymbol", { address: "0x1", newName: "a" }, {});
  l.record("renameSymbol", { address: "0x2", newName: "b" }, {});
  l.record("undo", {}, {}); // "b" waits on the redo stack
  l.reconcile({ canUndo: false, canRedo: false, dirty: true });
  assert.deepEqual(live(l), ["Rename to a"]);
  assert.equal(l.items.length, 1); // the redo entry is gone with the history
  assert.deepEqual([l.items[0].saved, l.items[0].locked], [false, true]);
  l.record("undo", {}, {});
  assert.deepEqual(live(l), ["Rename to a"]);
  l.reconcile({ canUndo: false, canRedo: false, dirty: false }); // a later analysis saves them
  assert.deepEqual([l.items[0].saved, l.items[0].locked], [true, false]);
});

test("agent edits are attributed by the identity of their params; the user's are not", () => {
  const l = new ChangeLog();
  const mine = tagParams({ address: "0x1", newName: "a" }, "claude-code");
  l.record("renameSymbol", mine, {});
  l.record("renameSymbol", { address: "0x2", newName: "b" }, {}); // the user's, between two agent edits
  l.record("renameSymbol", tagParams({ address: "0x3", newName: "c" }, "codex"), {});
  l.record("renameSymbol", { ...mine }, {}); // a copy is a different object: untagged (why tools must not spread)
  l.record("renameSymbol", mine, {}); // the same object again still tags
  assert.deepEqual(l.items.map((c) => c.by), ["claude-code", undefined, "codex", undefined, "claude-code"]);
  assert.ok(!("by" in l.items[1]));
});

test("undo and redo keep by", () => {
  const l = new ChangeLog();
  l.record("setComment", tagParams({ address: "0x1", kind: "eol", text: "x" }, "claude-code"), {});
  l.record("undo", {}, {});
  assert.deepEqual([l.items[0].undone, l.items[0].by], [true, "claude-code"]);
  l.record("redo", {}, {});
  assert.deepEqual([l.items[0].undone, l.items[0].by], [false, "claude-code"]);
});

test("an edit result's undoName is kept on the entry (what undo_agent_edit asks the provider to undo); an absent or odd one is not", () => {
  const l = new ChangeLog();
  l.record("renameSymbol", { address: "0x1", newName: "a" }, { undoName: "Rename x to a" });
  l.record("setComment", { address: "0x1", kind: "eol", text: "t" }, {});
  l.record("setBookmark", { address: "0x1", category: "c", comment: "x" }, { undoName: 5 });
  l.record("defineData", { address: "0x2", dataType: "int" }, undefined);
  assert.deepEqual(l.items.map((c) => c.undoName), ["Rename x to a", undefined, undefined, undefined]);
  l.record("undo", {}, {}); // undo and redo flip entries and keep what they carry
  assert.equal(l.items[0].undoName, "Rename x to a");
});

test("define types from C: one line, the declaration count and the category", () => {
  const l = new ChangeLog();
  l.record("parseCTypes", { c: "struct A { int a; };\ntypedef struct A A_t;\nenum E { X };\nstruct B { struct A a; };" }, { created: [], replaced: [], undoName: "Define types from C" });
  l.record("parseCTypes", { c: "union U { int a; };", category: "/net" }, {});
  assert.deepEqual(live(l), ["Define types from C (4)", "Define types from C in /net (1)"]);
  assert.equal(l.items[0].undoName, "Define types from C");
});
