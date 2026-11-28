import { build } from "esbuild";

await build({
  entryPoints: ["src/mcp/bridge.ts"],
  outfile: "out/mcp/bridge.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
});
