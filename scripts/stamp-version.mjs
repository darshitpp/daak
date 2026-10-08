#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv.includes("--check");
const { version, buildNumber } = JSON.parse(readFileSync("release/version.json", "utf8"));

const targets = [
  { file: "apps/mobile/android/app/build.gradle",
    re: /versionName "[^"]*"/, repl: `versionName "${version}"` },
  { file: "apps/mobile/android/app/build.gradle",
    re: /versionCode \d+/, repl: `versionCode ${buildNumber}` },
  { file: "apps/mobile/ios/Daak.xcodeproj/project.pbxproj",
    re: /MARKETING_VERSION = [^;]+;/g, repl: `MARKETING_VERSION = ${version};` },
  { file: "apps/mobile/ios/Daak.xcodeproj/project.pbxproj",
    re: /CURRENT_PROJECT_VERSION = [^;]+;/g, repl: `CURRENT_PROJECT_VERSION = ${buildNumber};` },
  { file: "apps/desktop/macos/Daak.xcodeproj/project.pbxproj",
    re: /MARKETING_VERSION = [^;]+;/g, repl: `MARKETING_VERSION = ${version};` },
  { file: "apps/desktop/macos/Daak.xcodeproj/project.pbxproj",
    re: /CURRENT_PROJECT_VERSION = [^;]+;/g, repl: `CURRENT_PROJECT_VERSION = ${buildNumber};` },
];

let drift = 0;
for (const t of targets) {
  const src = readFileSync(t.file, "utf8");
  const next = src.replace(t.re, t.repl);
  if (!src.match(t.re)) throw new Error(`no version marker in ${t.file}`);
  if (check) {
    if (src !== next) { console.error(`version drift: ${t.file}`); drift++; }
  } else if (src !== next) {
    writeFileSync(t.file, next);
  }
}
if (drift) { console.error(`${drift} file(s) out of sync with release/version.json`); process.exit(1); }
console.log(check ? `version ${version}+${buildNumber} OK` : `stamped ${version}+${buildNumber}`);
