import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const appName = "Codex Voice";
const appIdentifier = "com.openai.codex-voice.dev";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electronApp = join(repoRoot, "node_modules/electron/dist/Electron.app");
const infoPlist = join(electronApp, "Contents/Info.plist");
const devIcon = join(electronApp, "Contents/Resources/electron.icns");
const sourceIcon = join(repoRoot, "build/icon.icns");

if (!existsSync(infoPlist)) {
  throw new Error(`Electron app bundle is missing: ${infoPlist}`);
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
