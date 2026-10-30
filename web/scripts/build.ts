// Builds the static site into dist/: the compiled app (dist/app/), the files
// in public/, and a service worker stamped with this build's app shell. The Go
// server serves dist/ (`web_dir`); any static host can too.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], { stdio: "inherit" });
cpSync(join(root, "public"), dist, { recursive: true });

// The web version comes from package.json, stamped into the compiled version module.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const versionPath = join(dist, "app", "version.js");
const versionJs = readFileSync(versionPath, "utf8").replace(/WEB_VERSION = "[^"]*"/, `WEB_VERSION = ${JSON.stringify(pkg.version)}`);
if (!/^\d+\.\d+\.\d+/.test(pkg.version) || !versionJs.includes(`WEB_VERSION = "${pkg.version}"`)) throw new Error("couldn't stamp version.js");
writeFileSync(versionPath, versionJs);

// Every file the app needs offline, and a hash of them, which names the cache.
const shell = (readdirSync(dist, { recursive: true, withFileTypes: true }))
  .filter((f) => f.isFile() && f.name !== "sw.js")
  .map((f) => relative(dist, join(f.parentPath, f.name)).split(sep).join("/"))
  .sort();
const hash = createHash("sha256");
for (const file of shell) hash.update(file).update(readFileSync(join(dist, file)));
const version = hash.digest("hex").slice(0, 16);

const swPath = join(dist, "sw.js");
const sw = readFileSync(swPath, "utf8")
  .replace(/const BUILD_VERSION = .*;/, `const BUILD_VERSION = "${version}";`)
  .replace(/const SHELL = \[.*\];/, `const SHELL = ${JSON.stringify(["./", ...shell])};`);
if (!sw.includes(`"${version}"`) || !sw.includes(`"app/main.js"`)) throw new Error("couldn't stamp sw.js");
writeFileSync(swPath, sw);
console.log(`Built ${relative(process.cwd(), dist) || "."}: ${shell.length} files, shell ${version}`);
