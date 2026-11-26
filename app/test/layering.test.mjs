import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = new URL("../src/renderer/", import.meta.url);
const files = (await readdir(root, { recursive: true })).filter((p) => /\.tsx?$/.test(p));

test("the autotest and bench code is loaded only by dynamic import (it stays out of the main chunk)", async () => {
  for (const path of files) {
    if (path.startsWith("autotest/")) continue;
    const source = await readFile(new URL(path, root), "utf8");
    for (const line of source.split("\n")) {
      if (!/from\s*["'][^"']*\/autotest\//.test(line)) continue;
      assert.match(line, /^\s*import type\b/, `${path} imports autotest code statically: ${line.trim()}`);
    }
  }
  assert.match(await readFile(new URL("main.tsx", root), "utf8"), /import\("\.\/autotest\/autotest"\)/);
});

test("components and the store never reach into each other's wrong direction: store/ imports no component or feature", async () => {
  for (const path of files.filter((p) => p.startsWith("store/"))) {
    const source = await readFile(new URL(path, root), "utf8");
    for (const [, target] of source.matchAll(/from\s*["']([^"']+)["']/g)) {
      assert.doesNotMatch(target, /(?:^|\/)(?:features|App|Workbench|Shell|WelcomePane)(?:\/|$)/, `${path} imports ${target}`);
    }
  }
});
