// Fills the import map of each page in a web dir with content-hashed URLs:
// "./app.js" -> "./app.js?v=<sha256 prefix>", for every non-HTML file. Module
// imports follow the map natively; fetches and workers go through appUrl()
// (web/fetch-progress.js). So one page load never mixes cached old files with
// new ones, and unchanged files (envelopes, wasm) stay cached across deploys.
// Usage: node tools/stamp-urls.mjs web
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = process.argv[2];
const PLACEHOLDER = '<script type="importmap">{"imports": {}}</script>';

const imports = {};
const pages = [];
for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
  const file = path.join(dir, rel);
  if (!fs.statSync(file).isFile()) continue;
  if (rel.endsWith(".html")) { pages.push(file); continue; }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  const url = "./" + rel.split(path.sep).map(encodeURIComponent).join("/");
  imports[url] = `${url}?v=${hash}`;
}

const map = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");
  if (!html.includes(PLACEHOLDER)) continue;
  fs.writeFileSync(page, html.replace(PLACEHOLDER, map));
  console.log(`${page}: ${Object.keys(imports).length} URLs`);
}
