// fetch() with download progress. Totals come from sizes.json (written by
// tools/fetch-assets.sh): GitHub Pages gzips wasm/data, so Content-Length is the
// compressed size while the body stream yields decompressed bytes.

const ROOT = new URL("./", import.meta.url).href;
let sizes = null;

// The URL to load `path` (relative to the app root, or absolute) from. On a
// deploy, tools/stamp-urls.mjs puts an import map into the pages that maps each
// file to `<file>?v=<content hash>`, so a page never mixes cached old files
// with new ones. Locally the map is empty.
export const appUrl = (path) => import.meta.resolve(new URL(path, ROOT).href);

// Fetches `url` (relative to the app root, or absolute) as a Uint8Array.
// `onProgress(loaded, total)`; total is null if unknown.
export async function fetchBytes(url, onProgress) {
  sizes ??= fetch(appUrl("sizes.json")).then((r) => (r.ok ? r.json() : {}));
  const abs = new URL(url, ROOT).href;
  const resp = await fetch(appUrl(abs));
  if (!resp.ok) throw new Error(url + ": HTTP " + resp.status);
  const len = resp.headers.get("content-encoding") ? null : Number(resp.headers.get("content-length")) || null;
  const total = (await sizes)[abs.slice(ROOT.length)] ?? len;
  const chunks = [];
  let loaded = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export const mb = (n) => (n / 1048576).toFixed(1);
