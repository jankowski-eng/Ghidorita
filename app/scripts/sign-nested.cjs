// electron-builder afterSign hook: sign every nested Mach-O in Resources (jdk, python, ghidra natives, *.dylib, *.so) with the hardened runtime
// and the JIT entitlements, then re-sign the app bundle (its seal covers Resources). electron-builder only signs the Electron parts it knows about.
// No-op unless SIGN_IDENTITY is set, e.g. SIGN_IDENTITY="Developer ID Application: Name (TEAMID)". SIGN_IDENTITY=- tests the flow ad-hoc (no timestamp).
// Standalone: node scripts/sign-nested.cjs path/to/Ghidorita.app
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ENTITLEMENTS = path.resolve(__dirname, "../../packaging/entitlements.mac.plist");

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p; // symlinks are skipped: codesign follows them to the target, which is signed itself
  }
}

function isMachO(file) {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(8);
    if (fs.readSync(fd, b, 0, 8, 0) < 8) return false;
    if (b.readUInt32LE(0) === 0xfeedfacf) return true; // thin 64-bit Mach-O
    // fat Mach-O (the jpype _jpype.so is universal) shares CAFEBABE with Java .class files; there the next word is nfat_arch (a handful) vs a class version (>= 45)
    return b.readUInt32BE(0) === 0xcafebabe && b.readUInt32BE(4) < 20;
  } finally { fs.closeSync(fd); }
}

function signApp(app, identity) {
  const flags = ["--force", "--sign", identity, "--options", "runtime", "--timestamp" + (identity === "-" ? "=none" : ""), "--entitlements", ENTITLEMENTS];
  const files = [...walk(path.join(app, "Contents/Resources"))].filter(isMachO);
  for (const f of files) execFileSync("codesign", [...flags, f], { stdio: "inherit" });
  execFileSync("codesign", [...flags, app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`sign-nested: signed ${files.length} nested Mach-O files and ${path.basename(app)}`);
}

exports.default = async (ctx) => {
  const identity = process.env.SIGN_IDENTITY;
  if (!identity || process.platform !== "darwin") return;
  signApp(path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`), identity);
};

if (require.main === module) signApp(path.resolve(process.argv[2]), process.env.SIGN_IDENTITY ?? "-");
