import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async (f) => {
  const r = await build({ entryPoints: [new URL(`../src/renderer/${f}`, import.meta.url).pathname], bundle: true, format: "esm", write: false });
  return import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
};
const { parseBase, choiceError, buildOptions, optionsSummary, reopenParams, RAW_CANDIDATE } = await load("openOptions.ts");
const { windowTitle } = await load("session.ts");

test("parseBase: normalises, validates, 64-bit limit", () => {
  assert.deepEqual(parseBase(""), { ok: true, value: "" });
  assert.deepEqual(parseBase("  "), { ok: true, value: "" });
  assert.equal(parseBase("0x08000000").value, "0x8000000");
  assert.equal(parseBase("0XFF").value, "0xff");
  assert.equal(parseBase("1000").value, "0x1000");
  assert.equal(parseBase("0xffffffffffffffff").value, "0xffffffffffffffff");
  for (const bad of ["0x", "0xzz", "xyz", "-1", "0x1 2", "10000000000000000", "0x10000000000000000"]) assert.equal(parseBase(bad).ok, false, bad);
});

const macho = { loader: "Mach-O", language: "AARCH64:LE:64:v8A", compilerSpec: "default", preferred: true, acceptsBaseAddress: true };
const alt = { ...macho, language: "x86:LE:64:default", compilerSpec: "gcc", preferred: false };
const noBase = { ...macho, acceptsBaseAddress: false };
const ch = (cand, o = {}) => ({ cand, language: cand.language, compilerSpec: cand.compilerSpec, base: "", ...o });

test("buildOptions: untouched preferred candidate omits every option", () => {
  assert.equal(buildOptions(ch(macho)), undefined);
});
test("buildOptions: any deviation sends loader/language/compilerSpec explicitly", () => {
  assert.deepEqual(buildOptions(ch(alt)), { loader: "Mach-O", language: "x86:LE:64:default", compilerSpec: "gcc" }); // non-preferred candidate
  assert.deepEqual(buildOptions(ch(macho, { language: "ARM:LE:32:v8", compilerSpec: null })), { loader: "Mach-O", language: "ARM:LE:32:v8" });
  assert.deepEqual(buildOptions(ch(macho, { base: "4000" })), { loader: "Mach-O", language: macho.language, compilerSpec: "default", baseAddress: "0x4000" });
  assert.equal(buildOptions(ch(noBase, { base: "4000" })), undefined); // base ignored when the loader does not accept one
});
test("choiceError: language mandatory, base validated only when accepted", () => {
  assert.equal(choiceError(ch(macho)), null);
  assert.match(choiceError(ch(RAW_CANDIDATE)), /language/i); // language null forces a choice
  assert.equal(choiceError(ch(RAW_CANDIDATE, { language: "ARM:LE:32:v8" })), null);
  assert.ok(choiceError(ch(macho, { base: "0xzz" })));
  assert.equal(choiceError(ch(noBase, { base: "0xzz" })), null);
  assert.deepEqual(buildOptions(ch(RAW_CANDIDATE, { language: "ARM:LE:32:v8", base: "0x8000000" })), { loader: "Raw Binary", language: "ARM:LE:32:v8", baseAddress: "0x8000000" });
});
test("optionsSummary / reopenParams", () => {
  assert.equal(optionsSummary({}), "default");
  assert.equal(optionsSummary({ loader: "Raw Binary", language: "ARM:LE:32:v8", baseAddress: "0x8000000" }), "Raw Binary · ARM:LE:32:v8 · @0x8000000");
  assert.equal(reopenParams({ programId: "x", name: "n", sizeBytes: 1, analyzed: true, options: {} }), null);
  assert.deepEqual(reopenParams({ programId: "x", name: "n", sourcePath: "/a/n", sizeBytes: 1, analyzed: true, options: { loader: "L" } }), { path: "/a/n", loader: "L" });
});
test("windowTitle", () => {
  assert.equal(windowTitle(null, false), "Ghidrette");
  assert.equal(windowTitle("ls", false), "ls — Ghidrette");
  assert.equal(windowTitle("ls", true), "• ls — Ghidrette");
});

const { defaultProfile, FAST_MIN_BYTES } = await load("openOptions.ts");
test("defaultProfile: fast above 20 MB, full otherwise", () => {
  assert.equal(defaultProfile(4096), "full");
  assert.equal(defaultProfile(FAST_MIN_BYTES), "full");
  assert.equal(defaultProfile(FAST_MIN_BYTES + 1), "fast");
  assert.equal(defaultProfile(66.7 * 1048576), "fast");
});
test("buildOptions: profile fast is always sent, full never", () => {
  assert.deepEqual(buildOptions({ ...ch(macho), profile: "fast" }), { profile: "fast" });
  assert.equal(buildOptions({ ...ch(macho), profile: "full" }), undefined);
  assert.deepEqual(buildOptions({ ...ch(alt), profile: "fast" }), { loader: "Mach-O", language: "x86:LE:64:default", compilerSpec: "gcc", profile: "fast" });
  assert.deepEqual(buildOptions({ ...ch(macho), base: "0x10", profile: "fast" }), { loader: "Mach-O", language: "AARCH64:LE:64:v8A", compilerSpec: "default", baseAddress: "0x10", profile: "fast" });
});
test("optionsSummary / reopenParams carry the profile", () => {
  assert.equal(optionsSummary({ profile: "fast" }), "fast analysis");
  assert.equal(optionsSummary({ loader: "Raw Binary", language: "ARM:LE:32:v8", profile: "fast" }), "Raw Binary · ARM:LE:32:v8 · fast analysis");
  assert.deepEqual(reopenParams({ programId: "x", name: "n", sizeBytes: 1, analyzed: true, sourcePath: "/p", options: { profile: "fast" } }), { path: "/p", profile: "fast" });
});
