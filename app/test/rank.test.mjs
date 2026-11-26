import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/rank.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { rank } = await import("data:text/javascript," + encodeURIComponent(js));
const c = (name, kind, refs, group) => ({ name, kind, address: "0x1", refs, group });

test("empty query: entry point, then strings and imports by use, then functions by callers", () => {
  const r = rank("", [c("f_few", "function", 2, "function"), c("f_many", "function", 90, "function"), c("puts", "function", 7, "import"), c("usage: ls", "string", 12), c("entry", "function", 1, "entry"), c("memcpy", "function", 40, "import")]);
  assert.deepEqual(r.map((x) => x.name), ["entry", "memcpy", "usage: ls", "puts", "f_many", "f_few"]);
  assert.deepEqual([r[0].why, r[1].why, r[5].why], ["entry point", "used in 40 places", "used in 2 places"]);
});

test("a typed name: exact, then prefix, then the rest by usefulness", () => {
  const r = rank("Open", [c("reopen_all", "function", 99, "function"), c("open_file", "function", 3), c("open", "function", 1), c("openat", "function", 50)]);
  assert.deepEqual(r.map((x) => x.name), ["open", "openat", "open_file", "reopen_all"]);
});

test("one place is singular; no references: no reason", () => {
  assert.equal(rank("", [c("a", "function", 1)])[0].why, "used in 1 place");
  assert.equal(rank("", [c("a", "data", 0)])[0].why, "");
});

test("ties keep the incoming order", () => {
  assert.deepEqual(rank("", [c("b", "function", 5), c("a", "function", 5)]).map((x) => x.name), ["b", "a"]);
});
