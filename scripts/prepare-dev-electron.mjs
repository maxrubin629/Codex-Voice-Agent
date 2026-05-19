import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const appName = "Codex Voice Agent";
const appIdentifier = "com.maxrubin.codex-voice-agent.dev";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electronPackage = join(repoRoot, "node_modules/electron");
const electronInstallScript = join(electronPackage, "install.js");
const electronDist = join(electronPackage, "dist");
const electronApp = join(repoRoot, "node_modules/electron/dist/Electron.app");
const infoPlist = join(electronApp, "Contents/Info.plist");
const devIcon = join(electronApp, "Contents/Resources/electron.icns");
const sourceIcon = join(repoRoot, "build/icon.icns");

if (!existsSync(infoPlist)) {
  if (!existsSync(electronInstallScript)) {
    throw new Error(`Electron app bundle is missing and Electron is not installed. Run npm install first: ${infoPlist}`);
  }

  rmSync(electronDist, { recursive: true, force: true });
  execFileSync(process.execPath, [electronInstallScript], {
    cwd: electronPackage,
    env: process.env,
    stdio: "inherit",
  });
}

if (!existsSync(infoPlist)) {
  throw new Error(`Electron app bundle is still missing after reinstalling Electron: ${infoPlist}`);
}

if (existsSync(sourceIcon)) {
  copyFileSync(sourceIcon, devIcon);
}

for (const [key, value] of [
  ["CFBundleDisplayName", appName],
  ["CFBundleName", appName],
  ["CFBundleIdentifier", appIdentifier],
]) {
  execFileSync("plutil", ["-replace", key, "-string", value, infoPlist]);
}
