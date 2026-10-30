// Development server: rebuilds on change (tsc --watch) and serves dist/ on
// http://localhost:8081, forwarding /api and /healthz to a Sudoku server
// (http://localhost:8080, or API_URL). Unknown paths get index.html, as from
// the Go server, so /auth/callback works.
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const port = Number(process.env.PORT ?? 8081);
const api = new URL(process.env.API_URL ?? "http://localhost:8080");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
};

cpSync(join(root, "public"), dist, { recursive: true });
watch(join(root, "public"), { recursive: true }, () => cpSync(join(root, "public"), dist, { recursive: true }));
spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--watch", "--preserveWatchOutput"], { stdio: "inherit" });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(await req.toArray());
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k, v]) => k !== "host" && typeof v === "string")) as Record<string, string>;
      const upstream = await fetch(new URL(url.pathname + url.search, api), { method: req.method, headers, body });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502).end("Sudoku server unreachable at " + api.origin);
    }
    return;
  }
  let file = join(dist, normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Serving on http://localhost:${port}, API at ${api.origin}`));
