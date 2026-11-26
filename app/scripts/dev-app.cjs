// postinstall, macOS: the dev Electron in node_modules becomes Ghidorita.app, named "Ghidorita" in the Dock and menu bar with our icon
// (the Dock takes the bundle's CFBundleName; app.setName does not change it). Every launch goes through electron/path.txt, which is repointed.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") process.exit(0);
const pkg = path.dirname(require.resolve("electron/package.json"));
const from = path.join(pkg, "dist/Electron.app"), to = path.join(pkg, "dist/Ghidorita.app");
if (fs.existsSync(from)) { fs.rmSync(to, { recursive: true, force: true }); fs.renameSync(from, to); } // a reinstall brings Electron.app back
if (!fs.existsSync(to)) process.exit(0);

// The executable keeps its name: Electron's app.isPackaged is "the executable is not called electron", and the dev build must not look packaged.
const exe = path.join(to, "Contents/MacOS/Ghidorita");
if (fs.existsSync(exe)) fs.renameSync(exe, path.join(to, "Contents/MacOS/Electron")); // undo an earlier version of this script
const plist = path.join(to, "Contents/Info.plist");
for (const [k, v] of [["CFBundleExecutable", "Electron"], ["CFBundleName", "Ghidorita"], ["CFBundleDisplayName", "Ghidorita"], ["CFBundleIdentifier", "li.jankowski.ghidorita.dev"]])
  execFileSync("plutil", ["-replace", k, "-string", v, plist]);
execFileSync("sips", ["-s", "format", "icns", path.join(__dirname, "../build/icon.png"), "--out", path.join(to, "Contents/Resources/electron.icns")], { stdio: "ignore" });
execFileSync("codesign", ["--force", "--deep", "--sign", "-", to], { stdio: "ignore" }); // the edits break the bundle's seal; re-sign ad hoc
fs.writeFileSync(path.join(pkg, "path.txt"), "Ghidorita.app/Contents/MacOS/Electron");
