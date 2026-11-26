import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// bundle each TS module (they import each other) into a data: module
const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { emptyNav, push, goBack, goForward, NAV_CAP } = await load("nav.ts");
const { resolveGoto, pickHit } = await load("parseGoto.ts");
const { latest } = await load("latest.ts");
const { affectedTabs } = await load("changes.ts");
const { emptyTabs, openFunction, pinTab, closeTab, activateTab, droppedIds } = await load("tabs.ts");

const L = (address, source = "listing") => ({ address, source });
const addrs = (xs) => xs.map((x) => x.address);

test("nav: push, back, forward, clears forward, collapses duplicates", () => {
  let n = emptyNav;
  for (const a of ["0x1", "0x2", "0x2", "0x3"]) n = push(n, L(a));
  assert.deepEqual(addrs(n.back), ["0x1", "0x2"]);
  assert.equal(n.current.address, "0x3");
  n = goBack(n); assert.equal(n.current.address, "0x2");
  n = goBack(n); assert.equal(n.current.address, "0x1");
  assert.equal(goBack(n), n); // at the start
  n = goForward(n); assert.equal(n.current.address, "0x2");
  n = push(n, L("0x9")); // clears forward
  assert.deepEqual(n.forward, []); assert.deepEqual(addrs(n.back), ["0x1", "0x2"]);
  assert.equal(goForward(n), n);
  assert.equal(push(n, L("0X9")), n); // case-insensitive duplicate
});
test("nav: capped", () => {
  let n = emptyNav;
  for (let i = 0; i < NAV_CAP + 50; i++) n = push(n, L("0x" + i.toString(16)));
  assert.equal(n.back.length, NAV_CAP);
  assert.equal(n.back[0].address, "0x" + (49).toString(16)); // oldest dropped
});

const H = (name, address, kind = "function") => ({ name, address, kind });
const DB = [H("zeta", "0x3000"), H("main", "0x1000"), H("mainloop", "0x2000"), H("main_label", "0x1500", "label"), H("add", "0x5000"), H("Foo", "0x6000")];
const search = async (q) => DB.filter((h) => h.name.toLowerCase().includes(q.toLowerCase()));
test("pickHit: exact, then ignore-case, then prefix; functions first", () => {
  assert.equal(pickHit(DB, "main").address, "0x1000");
  assert.equal(pickHit(DB, "FOO").address, "0x6000");
  assert.equal(pickHit(DB, "mainl").address, "0x2000");
  assert.equal(pickHit([H("xmain", "0x1")], "main"), null); // substring only: not a match for go-to
  assert.equal(pickHit([H("m_x", "0x1", "label"), H("m_y", "0x2")], "m_").address, "0x2");
});
test("resolveGoto", async () => {
  const ok = async (s) => (await resolveGoto(s, search)).address;
  assert.equal(await ok("0x401000"), "0x401000");
  assert.equal(await ok(" 401000 "), "0x401000");
  assert.equal(await ok("0X00ff"), "0xff");
  assert.equal(await ok("main"), "0x1000");
  assert.equal(await ok("add"), "0x5000"); // a name that is also hex: the symbol wins
  assert.equal(await ok("ad"), "0xad");    // bare hex beats a prefix
  assert.equal(await ok("mainl"), "0x2000");
  for (const bad of ["", "  ", "0x", "0xzz", "0x1ffffffffffffffff", "nope"]) assert.ok("error" in (await resolveGoto(bad, search)), bad);
});
test("latest: only the newest request resolves", async () => {
  const run = latest();
  const slow = new Promise((r) => setTimeout(() => r("old"), 30));
  const a = run(slow), b = run(Promise.resolve("new"));
  assert.equal(await b, "new"); assert.equal(await a, null);
  const c = run(Promise.reject(new Error("stale"))), d = run(Promise.resolve(1));
  assert.equal(await c, null); assert.equal(await d, 1);
  await assert.rejects(run(Promise.reject(new Error("current"))));
});
test("affectedTabs", () => {
  const tabs = [{ id: 1, entry: "0x1000" }, { id: 2, entry: "0x2000" }, { id: 3, entry: "0x3000" }];
  const funcs = [{ name: "a", entry: "0x1000", size: 0x10 }, { name: "b", entry: "0x2000", size: 0x10 }, { name: "c", entry: "0x3000", size: 0x10 }];
  assert.deepEqual(affectedTabs(null, tabs, funcs), [1, 2, 3]);
  assert.deepEqual(affectedTabs([{ start: "0x100f", end: "0x2000" }], tabs, funcs), [1, 2]); // end inclusive
  assert.deepEqual(affectedTabs([{ start: "0x2010", end: "0x2fff" }], tabs, funcs), []);
  assert.deepEqual(affectedTabs([], tabs, funcs), []);
});

test("tabs: preview replace, pin, reuse, close", () => {
  let t = openFunction(emptyTabs, "0x1");
  const t1 = openFunction(t, "0x2"); // replaces preview
  assert.deepEqual(t1.tabs.map((x) => x.entry), ["0x2"]); assert.deepEqual(droppedIds(t, t1), [1]);
  t = openFunction(t1, "0x2"); assert.equal(t.tabs.length, 1); // reuse
  t = pinTab(t, t.active);
  t = openFunction(t, "0x3"); // pinned stays, new preview added
  assert.deepEqual(t.tabs.map((x) => [x.entry, x.pinned]), [["0x2", true], ["0x3", false]]);
  t = openFunction(t, "0x4"); assert.deepEqual(t.tabs.map((x) => x.entry), ["0x2", "0x4"]);
  t = openFunction(t, "0x4", true); assert.ok(t.tabs[1].pinned); assert.equal(t.tabs.length, 2); // double-click pins existing
  t = openFunction(t, "0x5", true); assert.equal(t.tabs.length, 3); // pinned open never replaces
  const a = t.active; t = activateTab(t, t.tabs[0].id); assert.notEqual(t.active, a);
  t = closeTab(t, t.tabs[0].id); assert.equal(t.tabs.length, 2); assert.equal(t.active, t.tabs[0].id); // neighbour
  assert.equal(closeTab(t, 999), t);
  for (const x of [...t.tabs]) t = closeTab(t, x.id);
  assert.equal(t.active, null);
});
