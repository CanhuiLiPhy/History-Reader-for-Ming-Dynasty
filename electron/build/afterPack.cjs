/**
 * electron-builder afterPack hook: ad-hoc sign the app on macOS so it launches
 * on Apple Silicon (arm64 enforces signing even for unsigned apps).
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  try {
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--verify", "--verbose=2", appPath], { stdio: "inherit" });
    console.log("[afterPack] ad-hoc sign OK");
  } catch (err) {
    console.warn("[afterPack] codesign failed:", err.message);
  }
};
