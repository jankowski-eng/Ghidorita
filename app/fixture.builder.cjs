const { build } = require("./package.json");

module.exports = {
  ...build,
  directories: { ...build.directories, output: "dist/fixture" },
  extraResources: build.extraResources.filter(({ to }) => to === "providers/fixture.cjs"),
};
