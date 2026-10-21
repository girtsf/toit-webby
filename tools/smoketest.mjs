// Smoke test of a deployed (or local) app, in headless Chrome; no hardware.
// Checks: selftest.html passes; the app reaches "ready" without page errors;
// with --versioned, every same-origin file is loaded with a content hash
// (tools/stamp-urls.mjs); an esp32s3 flash image builds in the browser.
// Usage: node smoketest.mjs <app base URL> [--versioned]
import puppeteer from "puppeteer";

const base = new URL(process.argv[2]);
const VERSIONED = process.argv.includes("--versioned");
// A fresh query on the page URL skips any cached copy of the HTML; everything
// it loads is content-hashed.
const bust = "?smoke=" + Date.now();

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const failures = [];
const check = (ok, what) => {
  console.log((ok ? "ok    " : "FAIL  ") + what);
  if (!ok) failures.push(what);
};

async function open(path) {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(new URL(path + bust, base).href, { waitUntil: "networkidle2", timeout: 60000 });
  return { page, errors, requests };
}

try {
  {
    const { page, errors } = await open("selftest.html");
    await page.waitForFunction(() => /ALL GOOD|FAILED/.test(document.getElementById("out").textContent),
      { timeout: 120000 });
    const out = await page.$eval("#out", (e) => e.innerText);
    check(out.includes("ALL GOOD") && errors.length === 0, "selftest: " + out.split("\n").pop() + errors.join("; "));
    await page.close();
  }

  const { page, errors, requests } = await open("index.html");
  await page.waitForFunction(() => document.getElementById("status").textContent !== "loading…",
    { timeout: 60000 }).catch(() => {});
  const status = await page.$eval("#status", (e) => e.textContent);
  check(status === "ready" && errors.length === 0, `app status "${status}"` + (errors.length ? ": " + errors.join("; ") : ""));

  const r = await page.evaluate(async () => {
    const toit = await import("./toit-runtime.js");
    const { appUrl } = await import("./fetch-progress.js");
    const get = async (p) => {
      const resp = await fetch(appUrl(p));
      if (!resp.ok) throw new Error(p + ": HTTP " + resp.status);
      return new Uint8Array(await resp.arrayBuffer());
    };
    const gz = await get("assets/firmware-esp32s3.envelope.gz");
    const envelope = new Uint8Array(await new Response(
      new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const t0 = performance.now();
    const fw = await toit.buildFlashParts(envelope, {
      name: "smoke", id: "00000000-0000-4000-8000-000000000000",
      jaguarSnapshot: await get("assets/jaguar-webby.snapshot"), flashSizeMB: 16,
    });
    return { parts: fw.parts.map((p) => p.address), mb: fw.flashSizeMB, ms: Math.round(performance.now() - t0) };
  }).catch((e) => ({ error: e.message }));
  check(r.parts?.join() === "0,32768,53248,65536" && r.mb === 16,
    "esp32s3 firmware (16 MB): " + (r.error ?? `parts ${r.parts?.map((a) => "0x" + a.toString(16))} in ${r.ms} ms`));

  if (VERSIONED) {
    // Worker requests don't show up here, but the page's own do.
    const plain = requests.filter((u) => u.startsWith(base.origin) && !u.includes("?v=") &&
      !u.includes("?smoke=") && !u.endsWith("/favicon.ico"));
    check(plain.length === 0, "all files content-hashed" + (plain.length ? ": " + plain.join(", ") : ""));
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
