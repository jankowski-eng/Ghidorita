import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

const js = transformSync(readFileSync(new URL("../src/renderer/rank.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code;
const { rank, score, classifyImport, W_ENTRY, W_INPUT_IMPORT, W_DANGEROUS_IMPORT, W_CRYPTO_IMPORT, W_STRING, W_OTHER_IMPORT, W_FUNCTION } = await import("data:text/javascript," + encodeURIComponent(js));
const c = (name, kind, refs, group) => ({ name, kind, address: "0x1", refs, group });

test("empty query: ordered by score = kind weight + 10 x log2(1 + references)", () => {
  const r = rank("", [c("f_few", "function", 2, "function"), c("f_many", "function", 90, "function"), c("puts", "function", 7, "import"), c("usage: ls", "string", 12), c("entry", "function", 1, "entry"), c("memcpy", "function", 40, "import")]);
  // entry 100+10, f_many 20+65, memcpy 30+54, string 40+37, puts 30+30, f_few 20+16
  assert.deepEqual(r.map((x) => [x.name, x.score]), [["entry", 110], ["f_many", 85], ["memcpy", 84], ["usage: ls", 77], ["puts", 60], ["f_few", 36]]);
  assert.deepEqual([r[0].why, r[2].why, r[5].why], ["entry point", "used in 40 places", "used in 2 places"]);
});

test("score: the published weights and the log term, exactly", () => {
  const s = (name, kind, refs, group) => score(c(name, kind, refs, group));
  assert.equal(s("start", "function", 0, "entry"), W_ENTRY);
  assert.equal(s("read", "function", 1, "import"), W_INPUT_IMPORT + 10);       // log2(2) = 1
  assert.equal(s("strcpy", "function", 3, "import"), W_DANGEROUS_IMPORT + 20); // log2(4) = 2
  assert.equal(s("EVP_EncryptInit", "function", 7, "import"), W_CRYPTO_IMPORT + 30);
  assert.equal(s("puts", "function", 0, "import"), W_OTHER_IMPORT);
  assert.equal(s("hello", "string", 15, undefined), W_STRING + 40);
  assert.equal(s("sub_1", "function", 1, "function"), W_FUNCTION + 10);
  assert.deepEqual([W_ENTRY, W_INPUT_IMPORT, W_DANGEROUS_IMPORT, W_CRYPTO_IMPORT], [100, 70, 60, 50]);
  assert.ok(W_STRING > W_OTHER_IMPORT && W_OTHER_IMPORT > W_FUNCTION && W_FUNCTION > 0);
});

test("a heavily used plain function can outrank a rarely used dangerous import (weights and references trade off)", () => {
  const r = rank("", [c("strcpy", "function", 1, "import"), c("hot", "function", 2000, "function")]);
  assert.deepEqual(r.map((x) => x.name), ["hot", "strcpy"]); // 20+110 vs 60+10
  assert.equal(rank("", [c("strcpy", "function", 5, "import")])[0].why, "dangerous call \u00b7 used in 5 places");
});

test("classifyImport: decoration is stripped; input beats dangerous beats crypto", () => {
  for (const [n, k] of [["read", "input"], ["_fgets", "input"], ["recv@plt", "input"], ["__isoc99_scanf", "input"], ["__imp_ReadFile", "input"], ["gets", "input"],
    ["__sprintf_chk", "dangerous"], ["strcpy$stub", "dangerous"], ["system", "dangerous"], ["CreateProcessW", "dangerous"], ["EVP_DigestInit", "crypto"], ["SHA256_Update", "crypto"], ["CCCrypt", "crypto"],
    ["puts", null], ["malloc", null], ["readdir", null], ["shake", null]]) assert.equal(classifyImport(n), k, n);
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

test("isLeadString: source paths and tiny bare words are not leads; ordinary strings and other paths are", async () => {
  const { isLeadString } = await import("data:text/javascript," + encodeURIComponent(js));
  for (const v of ["/AppleInternal/Library/BuildRoots/x/Sources/OpenSSH/openssh/ssh-keygen.c", "src/main.cpp", "main", "eiou"]) assert.equal(isLeadString(v), false, v);
  for (const v of ["Enter passphrase:", "/etc/ssh/ssh_config", "/usr/lib/dyld", "update_krl_from_file", "usage: ls", "main.c is missing"]) assert.equal(isLeadString(v), true, v);
});
