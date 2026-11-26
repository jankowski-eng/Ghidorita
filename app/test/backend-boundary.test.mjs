import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

test("renderer features import application operations and data types only", async () => {
  const root = new URL("../src/renderer/", import.meta.url);
  const adapters = new Set(["rpc.ts", "wire.ts"]);
  const bootstrap = new Set(["main.tsx", ...adapters]);
  for (const path of await readdir(root, { recursive: true })) {
    if (!/\.tsx?$/.test(path) || bootstrap.has(path)) continue;
    const source = await readFile(new URL(path, root), "utf8");
    const imports = source.matchAll(/(?:\b(?:from|import|require)\s*(?:\(\s*)?)(["'])([^"']+)\1/g);
    for (const [, , target] of imports) {
      assert.doesNotMatch(target, /(?:^|\/)(?:rpc|wire|client|providers?|providerProcess)(?:\/|\.|$)/i, `${path} imports ${target}`);
    }
    assert.doesNotMatch(source, /\b(?:Methods|Notifications|ErrorCode)\b[^;]*from\s*["'][^"']*\/protocol["']/, `${path} imports wire names`);
  }
});
