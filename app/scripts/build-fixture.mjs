import { build } from "esbuild";

await build({
  entryPoints: ["providers/fixture.mjs"],
  outfile: "out/providers/fixture.cjs",
  bundle: true,
  platform: "node",
  external: ["bufferutil", "utf-8-validate"],
});
