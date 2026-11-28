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

test("src/agent/ is environment-agnostic: only backend.ts, parseGoto.ts, address.ts, protocol.ts and its own files (never rpc, wire, React, the store or Electron)", async () => {
  const dir = new URL("../src/agent/", import.meta.url);
  const allowed = /^(?:(?:\.\.\/)+(?:renderer\/(?:backend|parseGoto|address)|protocol)|\.\/[\w/]+|\.\.\/[\w]+|node:(?:os|path))$/;
  const names = (await readdir(dir, { recursive: true })).filter((p) => /\.tsx?$/.test(p));
  assert.ok(names.length >= 8);
  for (const path of names) {
    const source = await readFile(new URL(path, dir), "utf8");
    for (const [, a, b] of source.matchAll(/^(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\)/gm)) {
      const target = a ?? b;
      assert.match(target, allowed, `src/agent/${path} imports ${target}`);
    }
  }
});

test("the main process imports the agent layer but the agent layer never imports main or the preload", async () => {
  for (const path of (await readdir(new URL("../src/agent/", import.meta.url), { recursive: true })).filter((p) => /\.tsx?$/.test(p)))
    assert.doesNotMatch(await readFile(new URL("../src/agent/" + path, import.meta.url), "utf8"), /from\s*["'][^"']*\/(?:main|preload)\//, path);
});
