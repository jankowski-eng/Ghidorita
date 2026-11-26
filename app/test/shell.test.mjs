import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// bundle each TS module (they import each other) into a data: module
const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { emptyNav, push, goBack, goForward, NAV_CAP } = await load("nav.ts");
const { FuncIndex, containingFunction, findFunctionByName } = await load("funcs.ts");
const { parseGoto } = await load("parseGoto.ts");
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

const F = [{ name: "zeta", entry: "0x3000", size: 0x10 }, { name: "main", entry: "0x1000", size: 0x20 }, { name: "mainloop", entry: "0x2000", size: 0x10 }, { name: "thunk", entry: "0x4000", size: 0 }, { name: "add", entry: "0x5000", size: 4 }];
test("containingFunction", () => {
  const idx = new FuncIndex(F);
  assert.equal(containingFunction(idx, "0x1000").name, "main");
  assert.equal(containingFunction(idx, "0x101f").name, "main");
  assert.equal(containingFunction(idx, "0x1020"), null); // gap
  assert.equal(containingFunction(idx, "0xfff"), null);  // before first
  assert.equal(containingFunction(idx, "0x3005").name, "zeta");
  assert.equal(containingFunction(idx, "0x4000").name, "thunk"); // size 0 matches its entry only
  assert.equal(containingFunction(idx, "0x4001"), null);
  assert.equal(containingFunction(idx, "0xffffffffffffffff"), null);
  assert.equal(containingFunction(idx, "nonsense"), null);
  assert.equal(containingFunction(new FuncIndex([]), "0x1"), null);
});
test("findFunctionByName: exact beats prefix", () => {
  assert.equal(findFunctionByName(F, "main").entry, "0x1000");
  assert.equal(findFunctionByName(F, "mainl").entry, "0x2000");
  assert.equal(findFunctionByName(F, "ZET").entry, "0x3000");
  assert.equal(findFunctionByName(F, "q"), null);
});
test("parseGoto", () => {
  assert.deepEqual(parseGoto("0x401000", F), { address: "0x401000" });
  assert.deepEqual(parseGoto(" 401000 ", F), { address: "0x401000" });
  assert.deepEqual(parseGoto("0X00ff", F), { address: "0xff" });
  assert.deepEqual(parseGoto("main", F), { address: "0x1000" });
  assert.deepEqual(parseGoto("add", F), { address: "0x5000" }); // a name that is also hex: the function wins
  assert.deepEqual(parseGoto("ad", F), { address: "0xad" });  // bare hex beats a name prefix
  assert.deepEqual(parseGoto("mainl", F), { address: "0x2000" });
  for (const bad of ["", "  ", "0x", "0xzz", "0x1ffffffffffffffff", "nope"]) assert.ok("error" in parseGoto(bad, F), bad);
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
