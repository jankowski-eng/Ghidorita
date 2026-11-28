const { build } = require("./package.json");

module.exports = {
  ...build,
  extraMetadata: { ghidoritaProvider: "fixture" }, // providers.ts: the default provider of this distribution
  directories: { ...build.directories, output: "dist/fixture" },
  extraResources: build.extraResources.filter(({ to }) => to === "providers/fixture.cjs" || to.startsWith("mcp/")),
};
