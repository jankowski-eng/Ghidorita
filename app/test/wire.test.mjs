import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const r = await build({ entryPoints: [new URL("../src/renderer/wire.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { results } = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));

const session = { sessionId: "s", programId: "p", name: "n" };
const analysis = { state: "idle", analysis: "none", profile: "full", analyzer: "", done: 0, pct: -1 };
const cand = { loader: "ELF", language: "x86:LE:64:default", compilerSpec: "gcc", preferred: true, acceptsBaseAddress: false };
const layout = { entry: "0x1000", sections: [{ name: ".text", size: 10, entropy: 5.5 }] };
const row = { address: "0x1000", length: 1, bytes: "90", mnemonic: "nop", operands: "" };
const token = { line: 0, colStart: 0, colEnd: 1, kind: "keyword" };
const str = { address: "0x1000", value: "hi", length: 3, refs: 1, refFrom: [{ from: "0x1004", function: "main" }] };
const without = (o, k) => { const { [k]: _, ...rest } = o; return rest; };

// per method: a valid payload, [description, broken payload] cases (a consumed field missing or wrong), and an unknown extra field is always accepted
const cases = {
  import_candidates: [{ candidates: [cand], sizeBytes: 1, entropy: [1], layout },
    [["layout without sections", { candidates: [cand], sizeBytes: 1, entropy: [1], layout: { entry: null } }],
     ["section without entropy", { candidates: [cand], sizeBytes: 1, entropy: [1], layout: { entry: null, sections: [{ name: "a", size: 1 }] } }],
     ["no entropy", { candidates: [cand], sizeBytes: 1 }]]],
  provider_info: [{ version: 1, provider: "p", capabilities: ["decompile"] }, [["no capabilities", { version: 1, provider: "p" }]]],
  open_binary: [{ ...session, persisted: false, analysis }, [["no sessionId", without({ ...session, persisted: false }, "sessionId")], ["analysis without state", { ...session, persisted: false, analysis: without(analysis, "state") }]]],
  stack_frame: [{ entry: "0x1000", name: "f", localSize: 8, parameterSize: 4, slots: [{ offset: -8, size: 4, name: "x", dataType: "int", parameter: false, source: "user" }] },
    [["slot without name", { entry: "0x1000", name: "f", localSize: 8, parameterSize: 4, slots: [{ offset: -8, size: 4, dataType: "int", parameter: false, source: "user" }] }],
     ["slot with an unknown source", { entry: "0x1000", name: "f", localSize: 8, parameterSize: 4, slots: [{ offset: -8, size: 4, name: "x", dataType: "int", parameter: false, source: "guess" }] }]]],
  list_undefined_refs: [{ total: 1, items: [{ address: "0x2000", type: "pointer", from: "0x1000", function: "f" }] },
    [["item without from", { total: 1, items: [{ address: "0x2000", type: "read" }] }], ["unknown access", { total: 1, items: [{ address: "0x2000", type: "execute", from: "0x1000" }] }]]],
  parse_c_types: [{ created: ["/A"], replaced: [] }, [["no replaced", { created: [] }], ["a path that is not a string", { created: [1], replaced: [] }]]],
  listing_info: [{ totalBytes: 1, ranges: [{ start: "0x1000", size: 1 }] }, [["range without size", { totalBytes: 1, ranges: [{ start: "0x1000" }] }]]],
  listing_rows: [[row], [["row without bytes", [without(row, "bytes")]]]],
  list_functions: [[{ name: "f", entry: "0x1000", size: 1 }], [["function without entry", [{ name: "f", size: 1 }]]]],
  decompile: [{ text: "x", cached: false, tokens: [token] }, [["token without kind", { text: "x", cached: false, tokens: [without(token, "kind")] }]]],
  list_strings: [{ total: 1, items: [str] }, [["string without refs", { total: 1, items: [without(str, "refs")] }], ["refFrom without from", { total: 1, items: [{ ...str, refFrom: [{}] }] }]]],
};

for (const [method, [valid, broken]] of Object.entries(cases)) {
  test(`wire ${method}`, () => {
    assert.ok(results[method](valid), "valid payload");
    assert.ok(results[method](Array.isArray(valid) ? [{ ...valid[0], extra: 1 }] : { ...valid, extra: 1 }), "unknown extra field");
    for (const [why, payload] of broken) assert.ok(!results[method](payload), why);
  });
}
test("wire import_candidates accepts no layout and a null layout", () => {
  const base = { candidates: [cand], sizeBytes: 1, entropy: [1] };
  assert.ok(results.import_candidates(base) && results.import_candidates({ ...base, layout: null }));
});
